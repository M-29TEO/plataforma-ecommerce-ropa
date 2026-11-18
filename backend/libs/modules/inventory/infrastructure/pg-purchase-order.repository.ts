import { Injectable } from '@nestjs/common';
import { ConflictError, isUniqueViolation, Queryable } from '../../../shared-kernel';
import { PurchaseOrderFilter, PurchaseOrderRepository } from '../application/ports';
import { PurchaseOrder, PurchaseOrderItem, PurchaseOrderProps } from '../domain/purchase-order';

const COLUMNS = 'id, tenant_id, supplier_id, warehouse_id, number, status, expected_at, total, created_by, created_at';

interface OrderRow {
  id: string;
  tenant_id: string;
  supplier_id: string;
  warehouse_id: string;
  number: string;
  status: PurchaseOrderProps['status'];
  expected_at: string | null;
  total: string;
  created_by: string | null;
  created_at: Date;
}

interface ItemRow {
  id: string;
  purchase_order_id: string;
  variant_id: string;
  qty_ordered: number;
  qty_received: number;
  unit_cost: string;
}

function toItem(r: ItemRow): PurchaseOrderItem {
  return {
    id: r.id,
    variantId: r.variant_id,
    qtyOrdered: r.qty_ordered,
    qtyReceived: r.qty_received,
    unitCost: r.unit_cost,
  };
}

function toOrder(r: OrderRow, items: PurchaseOrderItem[]): PurchaseOrder {
  return PurchaseOrder.restore({
    id: r.id,
    tenantId: r.tenant_id,
    supplierId: r.supplier_id,
    warehouseId: r.warehouse_id,
    number: r.number,
    status: r.status,
    expectedAt: r.expected_at,
    total: r.total,
    createdBy: r.created_by,
    createdAt: r.created_at,
    items,
  });
}

@Injectable()
export class PgPurchaseOrderRepository extends PurchaseOrderRepository {
  async insert(q: Queryable, po: PurchaseOrder): Promise<void> {
    const p = po.toJSON();
    try {
      await q.query(
        `INSERT INTO inventory.purchase_orders
           (id, tenant_id, supplier_id, warehouse_id, number, status, expected_at, total, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [p.id, p.tenantId, p.supplierId, p.warehouseId, p.number, p.status, p.expectedAt, p.total, p.createdBy, p.createdAt],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('PO_NUMBER_TAKEN', `Ya existe una orden de compra ${p.number}`, { number: p.number });
      }
      throw error;
    }
    await q.query(
      `INSERT INTO inventory.purchase_order_items (id, purchase_order_id, variant_id, qty_ordered, qty_received, unit_cost)
       SELECT id, $1, variant_id, qty_ordered, qty_received, unit_cost
         FROM unnest($2::uuid[], $3::uuid[], $4::int[], $5::int[], $6::numeric[])
              AS t(id, variant_id, qty_ordered, qty_received, unit_cost)`,
      [
        p.id,
        p.items.map((i) => i.id),
        p.items.map((i) => i.variantId),
        p.items.map((i) => i.qtyOrdered),
        p.items.map((i) => i.qtyReceived),
        p.items.map((i) => i.unitCost),
      ],
    );
  }

  async findById(
    q: Queryable,
    tenantId: string,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<PurchaseOrder | null> {
    // Bloquear la cabecera basta: toda modificación de ítems pasa por este agregado.
    const { rows } = await q.query<OrderRow>(
      `SELECT ${COLUMNS} FROM inventory.purchase_orders
        WHERE tenant_id = $1 AND id = $2 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, id],
    );
    if (!rows[0]) return null;
    const items = await this.loadItems(q, [id]);
    return toOrder(rows[0], items.get(id) ?? []);
  }

  async list(q: Queryable, tenantId: string, filter: PurchaseOrderFilter): Promise<PurchaseOrder[]> {
    const where = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (filter.status) where.push(`status = $${values.push(filter.status)}`);
    if (filter.supplierId) where.push(`supplier_id = $${values.push(filter.supplierId)}`);
    if (filter.warehouseId) where.push(`warehouse_id = $${values.push(filter.warehouseId)}`);
    const limit = values.push(filter.limit);
    const offset = values.push(filter.offset);
    const { rows } = await q.query<OrderRow>(
      `SELECT ${COLUMNS} FROM inventory.purchase_orders
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id
        LIMIT $${limit} OFFSET $${offset}`,
      values,
    );
    const items = await this.loadItems(q, rows.map((r) => r.id));
    return rows.map((r) => toOrder(r, items.get(r.id) ?? []));
  }

  async save(q: Queryable, po: PurchaseOrder): Promise<void> {
    const p = po.toJSON();
    await q.query('UPDATE inventory.purchase_orders SET status = $3, total = $4 WHERE tenant_id = $1 AND id = $2', [
      p.tenantId,
      p.id,
      p.status,
      p.total,
    ]);
    await q.query(
      `UPDATE inventory.purchase_order_items i
          SET qty_received = t.qty_received
         FROM unnest($2::uuid[], $3::int[]) AS t(id, qty_received)
        WHERE i.purchase_order_id = $1 AND i.id = t.id AND i.qty_received <> t.qty_received`,
      [p.id, p.items.map((i) => i.id), p.items.map((i) => i.qtyReceived)],
    );
  }

  private async loadItems(q: Queryable, orderIds: string[]): Promise<Map<string, PurchaseOrderItem[]>> {
    const byOrder = new Map<string, PurchaseOrderItem[]>();
    if (orderIds.length === 0) return byOrder;
    const { rows } = await q.query<ItemRow>(
      `SELECT id, purchase_order_id, variant_id, qty_ordered, qty_received, unit_cost
         FROM inventory.purchase_order_items
        WHERE purchase_order_id = ANY($1::uuid[])
        ORDER BY variant_id`,
      [orderIds],
    );
    for (const r of rows) {
      const list = byOrder.get(r.purchase_order_id) ?? [];
      list.push(toItem(r));
      byOrder.set(r.purchase_order_id, list);
    }
    return byOrder;
  }
}
