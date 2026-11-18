import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, DomainEvent, OutboxWriter, ValidationError } from '../../../shared-kernel';
import {
  InsufficientStockError,
  OrderAlreadyReservedError,
  ReservationExpiredError,
  ReservationNotFoundError,
  WarehouseInactiveError,
} from '../domain/errors';
import { stockBelowThreshold } from '../domain/events';
import { aggregateByStockKey, normalizeReservationLines, Reservation, ReservationLine } from '../domain/reservation';
import { compareStockKey, crossedBelowThreshold } from '../domain/stock';
import { ReservationRepository, StockRepository, WarehouseRepository } from './ports';

export interface ReserveStockInput {
  tenantId: string;
  orderId: string;
  lines: ReservationLine[];
  /** Por defecto STOCK_RESERVATION_TTL_SECONDS (15 min). */
  ttlSeconds?: number;
}

export interface ReserveStockResult {
  orderId: string;
  expiresAt: Date;
  reservations: Reservation[];
  /** true si el pedido ya estaba reservado con las mismas líneas (reintento del llamador). */
  alreadyReserved: boolean;
}

export const MIN_TTL_SECONDS = 60;
/** 7 días: holgura sobre el plazo más largo de un pago (72 h, pedidos asistidos) más su margen. */
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const EXPIRED_BATCH_SIZE = 200;
const EXPIRED_MAX_BATCHES = 50;

@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(
    private readonly db: Database,
    private readonly reservations: ReservationRepository,
    private readonly stock: StockRepository,
    private readonly warehouses: WarehouseRepository,
    private readonly outbox: OutboxWriter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Reserva todas las líneas de un pedido o ninguna.
   *
   * Cada línea usa el UPDATE condicional atómico (ver "Patrones críticos" en docs/03):
   * la condición on_hand - reserved >= qty se evalúa con la fila ya bloqueada, así que
   * dos transacciones nunca pueden reservar la misma unidad. Las líneas se procesan
   * ordenadas por (variant_id, warehouse_id) para que los bloqueos no formen ciclos.
   */
  async reserve(input: ReserveStockInput): Promise<ReserveStockResult> {
    const lines = normalizeReservationLines(input.lines);
    const ttl = input.ttlSeconds ?? this.config.reservationTtlSeconds;
    if (!Number.isInteger(ttl) || ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
      throw new ValidationError('INVALID_TTL', `El TTL debe estar entre ${MIN_TTL_SECONDS} y ${MAX_TTL_SECONDS} s`);
    }

    return this.db.withTransaction(async (tx) => {
      await this.reservations.lockOrder(tx, input.orderId);

      const existing = await this.reservations.lockActiveByOrder(tx, input.tenantId, input.orderId);
      if (existing.length > 0 && existing.every((r) => !r.isExpired)) {
        // Reintento del llamador (p. ej. timeout de red): no se reserva dos veces.
        if (!sameLines(aggregateByStockKey(existing), lines)) throw new OrderAlreadyReservedError(input.orderId);
        const reservations = existing.map(({ isExpired: _isExpired, ...r }) => r);
        return { orderId: input.orderId, expiresAt: reservations[0].expiresAt, reservations, alreadyReserved: true };
      }
      if (existing.length > 0) {
        // Vencidas pero el job aún no pasó: se liberan aquí y se reserva de nuevo. Caso poco
        // frecuente; si llegara a cruzarse con otro pedido, PostgreSQL detecta el ciclo (40P01)
        // y aborta una de las dos transacciones sin dejar datos a medias.
        for (const line of aggregateByStockKey(existing)) await this.stock.releaseReserved(tx, line);
        await this.reservations.setStatus(tx, existing.map((r) => r.id), 'released');
      }

      const warehouseIds = [...new Set(lines.map((l) => l.warehouseId))];
      const active = await this.warehouses.findActiveIds(tx, input.tenantId, warehouseIds);
      const inactive = warehouseIds.filter((id) => !active.has(id));
      if (inactive.length > 0) throw new WarehouseInactiveError(inactive);

      const events: DomainEvent[] = [];
      for (const line of lines) {
        const result = await this.stock.tryReserve(tx, line);
        // 0 filas afectadas: no hay stock suficiente. La excepción provoca ROLLBACK de las líneas previas.
        if (!result) throw new InsufficientStockError(line.variantId, line.warehouseId, line.quantity);
        if (crossedBelowThreshold(result.available + line.quantity, result.available, result.reorderPoint)) {
          events.push(
            stockBelowThreshold(input.tenantId, {
              variantId: line.variantId,
              warehouseId: line.warehouseId,
              available: result.available,
              reorderPoint: result.reorderPoint,
              reorderQty: result.reorderQty,
              cause: 'reservation',
            }),
          );
        }
      }

      const reservations = await this.reservations.insertMany(tx, input.orderId, lines, ttl);
      await this.outbox.append(tx, events);
      return { orderId: input.orderId, expiresAt: reservations[0].expiresAt, reservations, alreadyReserved: false };
    });
  }

  /**
   * El pedido se pagó: las unidades reservadas salen físicamente (on_hand y reserved bajan
   * juntos) y se registra un movimiento 'sale' por línea en el ledger.
   */
  confirm(tenantId: string, orderId: string): Promise<Reservation[]> {
    return this.db.withTransaction(async (tx) => {
      await this.reservations.lockOrder(tx, orderId);
      const active = await this.reservations.lockActiveByOrder(tx, tenantId, orderId);
      if (active.length === 0) throw new ReservationNotFoundError(orderId);
      if (active.some((r) => r.isExpired)) throw new ReservationExpiredError(orderId);

      const lines = aggregateByStockKey(active);
      for (const line of lines) await this.stock.consumeReserved(tx, line);
      await this.stock.insertMovements(
        tx,
        lines.map((l) => ({
          variantId: l.variantId,
          warehouseId: l.warehouseId,
          quantity: -l.quantity,
          movementType: 'sale' as const,
          referenceType: 'order',
          referenceId: orderId,
          unitCost: null,
          reason: null,
          userId: null,
        })),
      );
      await this.reservations.setStatus(tx, active.map((r) => r.id), 'consumed');
      return active.map(({ isExpired: _isExpired, ...r }) => ({ ...r, status: 'consumed' as const }));
    });
  }

  /** Pedido cancelado o pago fallido: devuelve las unidades al disponible. Idempotente. */
  release(tenantId: string, orderId: string): Promise<{ released: number }> {
    return this.db.withTransaction(async (tx) => {
      await this.reservations.lockOrder(tx, orderId);
      const active = await this.reservations.lockActiveByOrder(tx, tenantId, orderId);
      if (active.length === 0) return { released: 0 };
      for (const line of aggregateByStockKey(active)) await this.stock.releaseReserved(tx, line);
      await this.reservations.setStatus(tx, active.map((r) => r.id), 'released');
      return { released: active.length };
    });
  }

  listByOrder(tenantId: string, orderId: string): Promise<Reservation[]> {
    return this.reservations.findByOrder(this.db, tenantId, orderId);
  }

  /**
   * Libera reservas vencidas en lotes (lo ejecuta el job cada minuto). Cada lote es una
   * transacción: marcar 'released' y devolver unidades ocurre junto o no ocurre.
   */
  async releaseExpired(batchSize = EXPIRED_BATCH_SIZE): Promise<{ released: number }> {
    let released = 0;
    for (let batch = 0; batch < EXPIRED_MAX_BATCHES; batch++) {
      const claimed = await this.db.withTransaction(async (tx) => {
        const rows = await this.reservations.claimExpired(tx, batchSize);
        for (const line of aggregateByStockKey(rows)) await this.stock.releaseReserved(tx, line);
        return rows.length;
      });
      released += claimed;
      if (claimed < batchSize) break;
    }
    if (released > 0) this.logger.log(`Reservas vencidas liberadas: ${released}`);
    return { released };
  }
}

function sameLines(a: ReservationLine[], b: ReservationLine[]): boolean {
  return (
    a.length === b.length && a.every((line, i) => compareStockKey(line, b[i]) === 0 && line.quantity === b[i].quantity)
  );
}
