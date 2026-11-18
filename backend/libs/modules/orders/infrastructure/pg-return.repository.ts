import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { ReturnFilter, ReturnRepository } from '../application/ports';
import { OPEN_RETURN_STATUSES, Return, ReturnItem, ReturnProps, ReturnStatus } from '../domain/return';

const COLUMNS = `r.id, r.tenant_id, r.order_id, r.rma_number, r.type, r.status, r.resolution, r.reason, r.customer_notes,
  r.refund_amount, r.return_shipping_paid_by, r.approved_by, r.created_at, r.closed_at`;

interface ReturnRow {
  id: string;
  tenant_id: string;
  order_id: string;
  rma_number: string;
  type: ReturnProps['type'];
  status: ReturnStatus;
  resolution: ReturnProps['resolution'];
  reason: string;
  customer_notes: string | null;
  refund_amount: string | null;
  return_shipping_paid_by: ReturnProps['returnShippingPaidBy'];
  approved_by: string | null;
  created_at: Date;
  closed_at: Date | null;
}

interface ItemRow {
  id: string;
  return_id: string;
  order_item_id: string;
  quantity: number;
  reason_code: ReturnItem['reasonCode'];
  condition: ReturnItem['condition'];
  restock: boolean | null;
  exchange_variant_id: string | null;
  photos: string[];
}

function toItem(r: ItemRow): ReturnItem {
  return {
    id: r.id,
    orderItemId: r.order_item_id,
    quantity: r.quantity,
    reasonCode: r.reason_code,
    condition: r.condition,
    restock: r.restock,
    exchangeVariantId: r.exchange_variant_id,
    photos: r.photos ?? [],
  };
}

function toProps(r: ReturnRow, items: ReturnItem[]): ReturnProps {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    orderId: r.order_id,
    rmaNumber: r.rma_number,
    type: r.type,
    status: r.status,
    resolution: r.resolution,
    reason: r.reason,
    customerNotes: r.customer_notes,
    refundAmount: r.refund_amount,
    returnShippingPaidBy: r.return_shipping_paid_by,
    approvedBy: r.approved_by,
    createdAt: r.created_at,
    closedAt: r.closed_at,
    items,
  };
}

@Injectable()
export class PgReturnRepository extends ReturnRepository {
  async insert(q: Queryable, ret: Return): Promise<void> {
    const p = ret.toJSON();
    await q.query(
      `INSERT INTO sales.returns
         (id, tenant_id, order_id, rma_number, type, status, resolution, reason, customer_notes, refund_amount,
          return_shipping_paid_by, approved_by, created_at, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        p.id, p.tenantId, p.orderId, p.rmaNumber, p.type, p.status, p.resolution, p.reason, p.customerNotes, p.refundAmount,
        p.returnShippingPaidBy, p.approvedBy, p.createdAt, p.closedAt,
      ],
    );
    await q.query(
      `INSERT INTO sales.return_items (id, return_id, order_item_id, quantity, reason_code, exchange_variant_id, photos)
       SELECT t.id, $1, t.order_item_id, t.quantity, t.reason_code, t.exchange_variant_id,
              COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(t.photos) AS x), '{}')
         FROM unnest($2::uuid[], $3::uuid[], $4::int[], $5::text[], $6::uuid[], $7::jsonb[])
              AS t(id, order_item_id, quantity, reason_code, exchange_variant_id, photos)`,
      [
        p.id,
        p.items.map((i) => i.id),
        p.items.map((i) => i.orderItemId),
        p.items.map((i) => i.quantity),
        p.items.map((i) => i.reasonCode),
        p.items.map((i) => i.exchangeVariantId),
        // text[][] no admite filas de distinto largo: cada lista de fotos viaja como jsonb.
        p.items.map((i) => JSON.stringify(i.photos)),
      ],
    );
  }

  async findById(q: Queryable, tenantId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<Return | null> {
    const { rows } = await q.query<ReturnRow>(
      `SELECT ${COLUMNS} FROM sales.returns r WHERE r.tenant_id = $1 AND r.id = $2 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, id],
    );
    if (!rows[0]) return null;
    const [ret] = await this.withItems(q, rows);
    return ret;
  }

  async list(q: Queryable, tenantId: string, f: ReturnFilter): Promise<Return[]> {
    const where = ['r.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (f.statuses?.length) where.push(`r.status = ANY($${values.push(f.statuses)}::text[])`);
    if (f.orderId) where.push(`r.order_id = $${values.push(f.orderId)}`);
    // Mismo schema (sales): el filtro por cliente mira el dueño del pedido.
    if (f.userId) where.push(`EXISTS (SELECT 1 FROM sales.orders o WHERE o.id = r.order_id AND o.user_id = $${values.push(f.userId)})`);
    const { rows } = await q.query<ReturnRow>(
      `SELECT ${COLUMNS} FROM sales.returns r WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC, r.rma_number DESC
        LIMIT $${values.push(f.limit)} OFFSET $${values.push(f.offset)}`,
      values,
    );
    return this.withItems(q, rows);
  }

  async update(q: Queryable, ret: Return, expectedStatus: ReturnStatus): Promise<boolean> {
    const p = ret.toJSON();
    const res = await q.query(
      `UPDATE sales.returns
          SET status = $3, resolution = $4, refund_amount = $5, approved_by = $6, closed_at = $7
        WHERE id = $1 AND status = $2`,
      [p.id, expectedStatus, p.status, p.resolution, p.refundAmount, p.approvedBy, p.closedAt],
    );
    if (res.rowCount !== 1) return false;
    await q.query(
      `UPDATE sales.return_items i SET condition = t.condition, restock = t.restock
         FROM unnest($2::uuid[], $3::text[], $4::boolean[]) AS t(id, condition, restock)
        WHERE i.return_id = $1 AND i.id = t.id`,
      [p.id, p.items.map((i) => i.id), p.items.map((i) => i.condition), p.items.map((i) => i.restock)],
    );
    return true;
  }

  async countByOrder(q: Queryable, orderId: string): Promise<number> {
    const { rows } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM sales.returns WHERE order_id = $1`, [orderId]);
    return rows[0].n;
  }

  async openQuantities(q: Queryable, orderId: string): Promise<Map<string, number>> {
    const { rows } = await q.query<{ order_item_id: string; qty: number }>(
      `SELECT i.order_item_id, sum(i.quantity)::int AS qty
         FROM sales.return_items i JOIN sales.returns r ON r.id = i.return_id
        WHERE r.order_id = $1 AND r.status = ANY($2::text[])
        GROUP BY i.order_item_id`,
      [orderId, OPEN_RETURN_STATUSES],
    );
    return new Map(rows.map((r) => [r.order_item_id, r.qty]));
  }

  private async withItems(q: Queryable, rows: ReturnRow[]): Promise<Return[]> {
    if (!rows.length) return [];
    const { rows: items } = await q.query<ItemRow>(
      `SELECT id, return_id, order_item_id, quantity, reason_code, condition, restock, exchange_variant_id, photos
         FROM sales.return_items WHERE return_id = ANY($1::uuid[]) ORDER BY return_id, id`,
      [rows.map((r) => r.id)],
    );
    return rows.map((r) => Return.restore(toProps(r, items.filter((i) => i.return_id === r.id).map(toItem))));
  }
}
