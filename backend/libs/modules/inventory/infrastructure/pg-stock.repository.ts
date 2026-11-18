import { Injectable } from '@nestjs/common';
import { buildSetClause, Queryable } from '../../../shared-kernel';
import { MovementFilter, ReserveResult, StockRepository, StockSettingsPatch } from '../application/ports';
import { WarehouseAvailability } from '../domain/allocation';
import { ReservationLine } from '../domain/reservation';
import { NewStockMovement, StockLevel, StockMovement } from '../domain/stock';

const COLUMNS = `variant_id, warehouse_id, on_hand, reserved, available,
                 reorder_point, reorder_qty, bin_location, version, updated_at`;

interface StockRow {
  variant_id: string;
  warehouse_id: string;
  on_hand: number;
  reserved: number;
  available: number;
  reorder_point: number;
  reorder_qty: number;
  bin_location: string | null;
  version: number;
  updated_at: Date;
}

function toStockLevel(r: StockRow): StockLevel {
  return {
    variantId: r.variant_id,
    warehouseId: r.warehouse_id,
    onHand: r.on_hand,
    reserved: r.reserved,
    available: r.available,
    reorderPoint: r.reorder_point,
    reorderQty: r.reorder_qty,
    binLocation: r.bin_location,
    version: r.version,
    updatedAt: r.updated_at,
  };
}

interface MovementRow {
  id: string;
  variant_id: string;
  warehouse_id: string;
  quantity: number;
  movement_type: StockMovement['movementType'];
  reference_type: string | null;
  reference_id: string | null;
  unit_cost: string | null;
  reason: string | null;
  user_id: string | null;
  created_at: Date;
}

const SETTINGS_COLUMNS: Record<string, string> = {
  reorderPoint: 'reorder_point',
  reorderQty: 'reorder_qty',
  binLocation: 'bin_location',
};

@Injectable()
export class PgStockRepository extends StockRepository {
  async find(q: Queryable, variantId: string, warehouseId: string): Promise<StockLevel | null> {
    const { rows } = await q.query<StockRow>(
      `SELECT ${COLUMNS} FROM inventory.stock_levels WHERE variant_id = $1 AND warehouse_id = $2`,
      [variantId, warehouseId],
    );
    return rows[0] ? toStockLevel(rows[0]) : null;
  }

  async listByWarehouse(
    q: Queryable,
    warehouseId: string,
    opts: { belowReorderPoint?: boolean; limit: number; offset: number },
  ): Promise<StockLevel[]> {
    // La condición coincide con el índice parcial ix_stock_low.
    const low = opts.belowReorderPoint ? 'AND on_hand - reserved <= reorder_point' : '';
    const { rows } = await q.query<StockRow>(
      `SELECT ${COLUMNS} FROM inventory.stock_levels
        WHERE warehouse_id = $1 ${low}
        ORDER BY variant_id
        LIMIT $2 OFFSET $3`,
      [warehouseId, opts.limit, opts.offset],
    );
    return rows.map(toStockLevel);
  }

  async listByVariant(q: Queryable, tenantId: string, variantId: string): Promise<StockLevel[]> {
    const { rows } = await q.query<StockRow>(
      `SELECT ${COLUMNS.replace(/(\w+)/g, 's.$1')}
         FROM inventory.stock_levels s
         JOIN inventory.warehouses w ON w.id = s.warehouse_id
        WHERE w.tenant_id = $1 AND s.variant_id = $2
        ORDER BY w.code`,
      [tenantId, variantId],
    );
    return rows.map(toStockLevel);
  }

  async lock(q: Queryable, variantId: string, warehouseId: string): Promise<StockLevel | null> {
    const { rows } = await q.query<StockRow>(
      `SELECT ${COLUMNS} FROM inventory.stock_levels
        WHERE variant_id = $1 AND warehouse_id = $2
        FOR UPDATE`,
      [variantId, warehouseId],
    );
    return rows[0] ? toStockLevel(rows[0]) : null;
  }

  /**
   * Patrón crítico nº 1 de docs/03. La fila queda bloqueada por el UPDATE; si otra
   * transacción la tenía, esta espera y PostgreSQL vuelve a evaluar el WHERE con los
   * valores ya confirmados (READ COMMITTED). Por eso nunca se reserva de más.
   */
  async tryReserve(q: Queryable, line: ReservationLine): Promise<ReserveResult | null> {
    const { rows } = await q.query<{ available: number; reorder_point: number; reorder_qty: number }>(
      `UPDATE inventory.stock_levels
          SET reserved = reserved + $3, version = version + 1, updated_at = now()
        WHERE variant_id = $1 AND warehouse_id = $2
          AND on_hand - reserved >= $3
        RETURNING available, reorder_point, reorder_qty`,
      [line.variantId, line.warehouseId, line.quantity],
    );
    const r = rows[0];
    return r ? { available: r.available, reorderPoint: r.reorder_point, reorderQty: r.reorder_qty } : null;
  }

  async releaseReserved(q: Queryable, line: ReservationLine): Promise<void> {
    await this.expectOneRow(
      q,
      `UPDATE inventory.stock_levels
          SET reserved = reserved - $3, version = version + 1, updated_at = now()
        WHERE variant_id = $1 AND warehouse_id = $2`,
      line,
    );
  }

  async consumeReserved(q: Queryable, line: ReservationLine): Promise<void> {
    await this.expectOneRow(
      q,
      `UPDATE inventory.stock_levels
          SET on_hand = on_hand - $3, reserved = reserved - $3, version = version + 1, updated_at = now()
        WHERE variant_id = $1 AND warehouse_id = $2`,
      line,
    );
  }

  async applyOnHandDelta(q: Queryable, variantId: string, warehouseId: string, delta: number): Promise<StockLevel> {
    if (delta < 0) {
      // Los CHECK se evalúan sobre la fila propuesta de un INSERT ... ON CONFLICT antes de
      // detectar el conflicto; una salida (delta negativo) solo puede ser un UPDATE.
      const { rows } = await q.query<StockRow>(
        `UPDATE inventory.stock_levels
            SET on_hand = on_hand + $3, version = version + 1, updated_at = now()
          WHERE variant_id = $1 AND warehouse_id = $2
          RETURNING ${COLUMNS}`,
        [variantId, warehouseId, delta],
      );
      if (!rows[0]) throw new Error(`Salida de stock sobre una fila inexistente ${variantId}/${warehouseId}`);
      return toStockLevel(rows[0]);
    }
    const { rows } = await q.query<StockRow>(
      `INSERT INTO inventory.stock_levels AS s (variant_id, warehouse_id, on_hand)
       VALUES ($1, $2, $3)
       ON CONFLICT (variant_id, warehouse_id) DO UPDATE
          SET on_hand = s.on_hand + EXCLUDED.on_hand, version = s.version + 1, updated_at = now()
       RETURNING ${COLUMNS}`,
      [variantId, warehouseId, delta],
    );
    return toStockLevel(rows[0]);
  }

  async updateSettings(
    q: Queryable,
    variantId: string,
    warehouseId: string,
    expectedVersion: number,
    patch: StockSettingsPatch,
  ): Promise<StockLevel | null> {
    const { sql, values } = buildSetClause({ ...patch }, SETTINGS_COLUMNS, 4);
    const sets = [sql, 'version = version + 1', 'updated_at = now()'].filter(Boolean).join(', ');
    const { rows } = await q.query<StockRow>(
      `UPDATE inventory.stock_levels SET ${sets}
        WHERE variant_id = $1 AND warehouse_id = $2 AND version = $3
        RETURNING ${COLUMNS}`,
      [variantId, warehouseId, expectedVersion, ...values],
    );
    return rows[0] ? toStockLevel(rows[0]) : null;
  }

  async insertMovements(q: Queryable, movements: NewStockMovement[]): Promise<void> {
    if (movements.length === 0) return;
    const values: unknown[] = [];
    const tuples = movements.map((m) => {
      const base = values.length;
      values.push(
        m.variantId,
        m.warehouseId,
        m.quantity,
        m.movementType,
        m.referenceType,
        m.referenceId,
        m.unitCost,
        m.reason,
        m.userId,
      );
      return `(${Array.from({ length: 9 }, (_, i) => `$${base + i + 1}`).join(', ')})`;
    });
    await q.query(
      `INSERT INTO inventory.stock_movements
         (variant_id, warehouse_id, quantity, movement_type, reference_type, reference_id, unit_cost, reason, user_id)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }

  async listMovements(q: Queryable, tenantId: string, filter: MovementFilter): Promise<StockMovement[]> {
    const where = ['w.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (filter.variantId) where.push(`m.variant_id = $${values.push(filter.variantId)}`);
    if (filter.warehouseId) where.push(`m.warehouse_id = $${values.push(filter.warehouseId)}`);
    if (filter.beforeId) where.push(`m.id < $${values.push(filter.beforeId)}`);
    values.push(filter.limit);
    const { rows } = await q.query<MovementRow>(
      `SELECT m.id, m.variant_id, m.warehouse_id, m.quantity, m.movement_type, m.reference_type,
              m.reference_id, m.unit_cost, m.reason, m.user_id, m.created_at
         FROM inventory.stock_movements m
         JOIN inventory.warehouses w ON w.id = m.warehouse_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.id DESC
        LIMIT $${values.length}`,
      values,
    );
    return rows.map((r) => ({
      id: r.id,
      variantId: r.variant_id,
      warehouseId: r.warehouse_id,
      quantity: r.quantity,
      movementType: r.movement_type,
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      unitCost: r.unit_cost,
      reason: r.reason,
      userId: r.user_id,
      createdAt: r.created_at,
    }));
  }

  async findMovementsByReference(q: Queryable, referenceType: string, referenceId: string): Promise<StockMovement[]> {
    const { rows } = await q.query<MovementRow>(
      `SELECT id, variant_id, warehouse_id, quantity, movement_type, reference_type, reference_id, unit_cost, reason, user_id, created_at
         FROM inventory.stock_movements WHERE reference_type = $1 AND reference_id = $2 ORDER BY id`,
      [referenceType, referenceId],
    );
    return rows.map((r) => ({
      id: r.id,
      variantId: r.variant_id,
      warehouseId: r.warehouse_id,
      quantity: r.quantity,
      movementType: r.movement_type,
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      unitCost: r.unit_cost,
      reason: r.reason,
      userId: r.user_id,
      createdAt: r.created_at,
    }));
  }

  async availabilityByVariant(q: Queryable, tenantId: string, variantIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>(variantIds.map((id) => [id, 0]));
    if (variantIds.length === 0) return result;
    const { rows } = await q.query<{ variant_id: string; available: number }>(
      `SELECT s.variant_id, SUM(s.available)::int AS available
         FROM inventory.stock_levels s
         JOIN inventory.warehouses w ON w.id = s.warehouse_id
        WHERE w.tenant_id = $1 AND w.active AND w.ships_online
          AND s.variant_id = ANY($2::uuid[])
        GROUP BY s.variant_id`,
      [tenantId, variantIds],
    );
    for (const r of rows) result.set(r.variant_id, r.available);
    return result;
  }

  async availabilityByWarehouse(
    q: Queryable,
    tenantId: string,
    variantIds: string[],
    warehouseId?: string | null,
  ): Promise<WarehouseAvailability[]> {
    if (variantIds.length === 0) return [];
    const { rows } = await q.query<{ variant_id: string; warehouse_id: string; available: number }>(
      `SELECT s.variant_id, s.warehouse_id, s.available
         FROM inventory.stock_levels s
         JOIN inventory.warehouses w ON w.id = s.warehouse_id
        WHERE w.tenant_id = $1 AND w.active AND s.variant_id = ANY($2::uuid[])
          AND (CASE WHEN $3::uuid IS NULL THEN w.ships_online ELSE w.id = $3 END)`,
      [tenantId, variantIds, warehouseId ?? null],
    );
    return rows.map((r) => ({ variantId: r.variant_id, warehouseId: r.warehouse_id, available: r.available }));
  }

  /** Estas operaciones solo se hacen sobre filas que la reserva ya garantizó; 0 filas es un bug. */
  private async expectOneRow(q: Queryable, sql: string, line: ReservationLine): Promise<void> {
    const res = await q.query(sql, [line.variantId, line.warehouseId, line.quantity]);
    if (res.rowCount !== 1) {
      throw new Error(`Inconsistencia de stock: no existe la fila ${line.variantId}/${line.warehouseId}`);
    }
  }
}
