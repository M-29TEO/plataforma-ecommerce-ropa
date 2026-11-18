import { Injectable } from '@nestjs/common';
import { Database, DomainEvent, OutboxWriter, Queryable, ValidationError } from '../../../shared-kernel';
import { AllocationShortageError, planAllocation } from '../domain/allocation';
import { InsufficientStockError, WarehouseInactiveError } from '../domain/errors';
import { stockBelowThreshold } from '../domain/events';
import { aggregateByStockKey, ReservationLine } from '../domain/reservation';
import { crossedBelowThreshold } from '../domain/stock';
import { StockRepository, WarehouseRepository } from './ports';

/** reference_type de los movimientos: una devolución que vuelve al stock y la salida de un cambio. */
export const RETURN_REFERENCE = 'return';
export const EXCHANGE_REFERENCE = 'exchange';

export interface RestockReturnInput {
  tenantId: string;
  returnId: string;
  /** Bodega que recibió el paquete. */
  warehouseId: string;
  userId: string | null;
  reason: string;
  /** Solo las unidades que la inspección marcó con restock = true. */
  lines: { variantId: string; quantity: number }[];
}

export interface ExchangeIssueInput {
  tenantId: string;
  returnId: string;
  userId: string | null;
  reason: string;
  /** Las variantes nuevas (otra talla) y sus cantidades. */
  lines: { variantId: string; quantity: number }[];
  /** Si esta bodega tiene todo, sale de ella (normalmente la que recibió la devolución). */
  preferredWarehouseId?: string | null;
}

/**
 * Stock de devoluciones y cambios. Ambas operaciones son idempotentes por devolución: los
 * movimientos del ledger (reference_type + reference_id, índice ix_movements_ref) dicen si ya se
 * aplicaron, así un reintento no repone ni descuenta dos veces.
 */
@Injectable()
export class ReturnStockService {
  constructor(
    private readonly db: Database,
    private readonly stock: StockRepository,
    private readonly warehouses: WarehouseRepository,
    private readonly outbox: OutboxWriter,
  ) {}

  /** Reingreso de lo devuelto en buen estado (on_hand += cantidad, movimiento 'return'). */
  restock(input: RestockReturnInput): Promise<{ restocked: number; alreadyApplied: boolean }> {
    return this.db.withTransaction(async (tx) => {
      const previous = await this.stock.findMovementsByReference(tx, RETURN_REFERENCE, input.returnId);
      if (previous.length) return { restocked: previous.reduce((s, m) => s + m.quantity, 0), alreadyApplied: true };
      const lines = this.normalize(input.lines.map((l) => ({ ...l, warehouseId: input.warehouseId })));
      if (!lines.length) return { restocked: 0, alreadyApplied: false };
      await this.assertActive(tx, input.tenantId, [input.warehouseId]);
      for (const l of lines) await this.stock.applyOnHandDelta(tx, l.variantId, l.warehouseId, l.quantity);
      await this.stock.insertMovements(
        tx,
        lines.map((l) => ({
          variantId: l.variantId,
          warehouseId: l.warehouseId,
          quantity: l.quantity,
          movementType: 'return' as const,
          referenceType: RETURN_REFERENCE,
          referenceId: input.returnId,
          unitCost: null,
          reason: input.reason,
          userId: input.userId,
        })),
      );
      return { restocked: lines.reduce((s, l) => s + l.quantity, 0), alreadyApplied: false };
    });
  }

  /**
   * Salida física de la talla nueva de un cambio: reparte entre bodegas (la preferida si alcanza),
   * y por cada línea hace el UPDATE condicional de la reserva y la consume en la misma transacción
   * (on_hand baja sin tocar lo reservado por otros pedidos). Lanza AllocationShortageError o
   * InsufficientStockError (409 INSUFFICIENT_STOCK) si no alcanza.
   */
  issueForExchange(input: ExchangeIssueInput): Promise<ReservationLine[]> {
    return this.db.withTransaction(async (tx) => {
      const previous = await this.stock.findMovementsByReference(tx, EXCHANGE_REFERENCE, input.returnId);
      if (previous.length) return previous.map((m) => ({ variantId: m.variantId, warehouseId: m.warehouseId, quantity: -m.quantity }));
      if (!input.lines.length) throw new ValidationError('EMPTY_EXCHANGE', 'El cambio no tiene líneas');

      const variantIds = [...new Set(input.lines.map((l) => l.variantId))];
      let plan: ReservationLine[] | null = null;
      if (input.preferredWarehouseId) {
        const local = await this.stock.availabilityByWarehouse(tx, input.tenantId, variantIds, input.preferredWarehouseId);
        try {
          plan = planAllocation(input.lines, local, { warehouseId: input.preferredWarehouseId });
        } catch (error) {
          if (!(error instanceof AllocationShortageError)) throw error;
        }
      }
      plan ??= planAllocation(input.lines, await this.stock.availabilityByWarehouse(tx, input.tenantId, variantIds));
      const lines = this.normalize(plan);
      await this.assertActive(tx, input.tenantId, [...new Set(lines.map((l) => l.warehouseId))]);

      const events: DomainEvent[] = [];
      for (const line of lines) {
        const result = await this.stock.tryReserve(tx, line);
        if (!result) throw new InsufficientStockError(line.variantId, line.warehouseId, line.quantity);
        await this.stock.consumeReserved(tx, line);
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
      await this.stock.insertMovements(
        tx,
        lines.map((l) => ({
          variantId: l.variantId,
          warehouseId: l.warehouseId,
          quantity: -l.quantity,
          movementType: 'sale' as const,
          referenceType: EXCHANGE_REFERENCE,
          referenceId: input.returnId,
          unitCost: null,
          reason: input.reason,
          userId: input.userId,
        })),
      );
      await this.outbox.append(tx, events);
      return lines;
    });
  }

  /** Agrupa por (variante, bodega) y ordena: mismo orden de bloqueo que las reservas (sin deadlocks). */
  private normalize(lines: ReservationLine[]): ReservationLine[] {
    for (const l of lines) {
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
        throw new ValidationError('INVALID_QUANTITY', 'Las cantidades deben ser enteros positivos', { ...l });
      }
    }
    return aggregateByStockKey(lines.map((l) => ({ ...l })));
  }

  private async assertActive(q: Queryable, tenantId: string, warehouseIds: string[]): Promise<void> {
    const active = await this.warehouses.findActiveIds(q, tenantId, warehouseIds);
    const inactive = warehouseIds.filter((id) => !active.has(id));
    if (inactive.length) throw new WarehouseInactiveError(inactive);
  }
}
