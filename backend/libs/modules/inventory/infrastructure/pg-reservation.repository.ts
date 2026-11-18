import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { ReservationRepository } from '../application/ports';
import { Reservation, ReservationLine, ReservationStatus } from '../domain/reservation';

const COLUMNS = 'id, variant_id, warehouse_id, order_id, quantity, status, expires_at, created_at';
const R_COLUMNS = COLUMNS.split(', ').map((c) => `r.${c}`).join(', ');

interface ReservationRow {
  id: string;
  variant_id: string;
  warehouse_id: string;
  order_id: string;
  quantity: number;
  status: ReservationStatus;
  expires_at: Date;
  created_at: Date;
}

function toReservation(r: ReservationRow): Reservation {
  return {
    id: r.id,
    variantId: r.variant_id,
    warehouseId: r.warehouse_id,
    orderId: r.order_id,
    quantity: r.quantity,
    status: r.status,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

@Injectable()
export class PgReservationRepository extends ReservationRepository {
  async lockOrder(q: Queryable, orderId: string): Promise<void> {
    // Lock consultivo a nivel de transacción: se libera solo en COMMIT/ROLLBACK.
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`inventory.order:${orderId}`]);
  }

  async insertMany(q: Queryable, orderId: string, lines: ReservationLine[], ttlSeconds: number): Promise<Reservation[]> {
    const values: unknown[] = [orderId, ttlSeconds];
    const tuples = lines.map((l) => {
      const v = values.push(l.variantId);
      const w = values.push(l.warehouseId);
      const n = values.push(l.quantity);
      return `($${v}, $${w}, $1, $${n}, now() + make_interval(secs => $2))`;
    });
    const { rows } = await q.query<ReservationRow>(
      `INSERT INTO inventory.stock_reservations (variant_id, warehouse_id, order_id, quantity, expires_at)
       VALUES ${tuples.join(', ')}
       RETURNING ${COLUMNS}`,
      values,
    );
    return rows.map(toReservation);
  }

  async findByOrder(q: Queryable, tenantId: string, orderId: string): Promise<Reservation[]> {
    const { rows } = await q.query<ReservationRow>(
      `SELECT ${R_COLUMNS}
         FROM inventory.stock_reservations r
         JOIN inventory.warehouses w ON w.id = r.warehouse_id
        WHERE w.tenant_id = $1 AND r.order_id = $2
        ORDER BY r.created_at, r.variant_id, r.warehouse_id`,
      [tenantId, orderId],
    );
    return rows.map(toReservation);
  }

  async lockActiveByOrder(
    q: Queryable,
    tenantId: string,
    orderId: string,
  ): Promise<(Reservation & { isExpired: boolean })[]> {
    const { rows } = await q.query<ReservationRow & { is_expired: boolean }>(
      `SELECT ${R_COLUMNS}, r.expires_at <= now() AS is_expired
         FROM inventory.stock_reservations r
         JOIN inventory.warehouses w ON w.id = r.warehouse_id
        WHERE w.tenant_id = $1 AND r.order_id = $2 AND r.status = 'active'
        ORDER BY r.variant_id, r.warehouse_id
        FOR UPDATE OF r`,
      [tenantId, orderId],
    );
    return rows.map((r) => ({ ...toReservation(r), isExpired: r.is_expired }));
  }

  async setStatus(q: Queryable, ids: string[], status: ReservationStatus): Promise<void> {
    if (ids.length === 0) return;
    await q.query('UPDATE inventory.stock_reservations SET status = $2 WHERE id = ANY($1::uuid[])', [ids, status]);
  }

  async claimExpired(q: Queryable, limit: number): Promise<Reservation[]> {
    // SKIP LOCKED: si otro worker (o un confirm/release) ya tiene la fila, se salta en vez de esperar.
    const { rows } = await q.query<ReservationRow>(
      `WITH expired AS (
         SELECT id FROM inventory.stock_reservations
          WHERE status = 'active' AND expires_at <= now()
          ORDER BY expires_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE inventory.stock_reservations r
          SET status = 'released'
         FROM expired
        WHERE r.id = expired.id
       RETURNING ${R_COLUMNS}`,
      [limit],
    );
    return rows.map(toReservation);
  }
}
