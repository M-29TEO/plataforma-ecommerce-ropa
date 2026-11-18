import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import {
  DeliveredLine,
  FulfillmentQueueEntry,
  FulfillmentQueueFilter,
  OrderFilter,
  OrderRepository,
  OrderSummary,
  StatusHistoryEntry,
} from '../application/ports';
import { Order, OrderItem, OrderProps, StatusChange } from '../domain/order';

/** Columnas de sales.orders que maneja el módulo (utm y exchange_rate quedan con su default). */
const ORDER_COLUMNS = `
  o.id, o.tenant_id, o.order_number, o.user_id, o.cart_id, o.customer, o.billing, o.status,
  o.payment_status, o.payment_method, o.fulfillment_type, o.shipping_address,
  ST_Y(o.shipping_location::geometry) AS shipping_lat, ST_X(o.shipping_location::geometry) AS shipping_lng,
  o.shipping_city, o.shipping_zone_id, o.delivery_slot_id, o.source_warehouse_id, o.currency,
  o.subtotal, o.discount_total, o.shipping_total, o.tax_total, o.gift_card_total, o.total, o.cost_total,
  o.channel, o.seller_id, o.notes, o.cancel_reason, o.placed_at, o.paid_at, o.shipped_at,
  o.delivered_at, o.cancelled_at, o.version, o.updated_at`;

interface OrderRow {
  id: string;
  tenant_id: string;
  order_number: string;
  user_id: string | null;
  cart_id: string | null;
  customer: OrderProps['customer'];
  billing: Record<string, unknown>;
  status: OrderProps['status'];
  payment_status: OrderProps['paymentStatus'];
  payment_method: OrderProps['paymentMethod'];
  fulfillment_type: OrderProps['fulfillmentType'];
  shipping_address: Record<string, unknown> | null;
  shipping_lat: number | null;
  shipping_lng: number | null;
  shipping_city: string | null;
  shipping_zone_id: string | null;
  delivery_slot_id: string | null;
  source_warehouse_id: string | null;
  currency: string;
  subtotal: string;
  discount_total: string;
  shipping_total: string;
  tax_total: string;
  gift_card_total: string;
  total: string;
  cost_total: string | null;
  channel: OrderProps['channel'];
  seller_id: string | null;
  notes: string | null;
  cancel_reason: string | null;
  placed_at: Date;
  paid_at: Date | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  version: number;
  updated_at: Date;
}

interface ItemRow {
  id: string;
  order_id: string;
  variant_id: string;
  product_id: string;
  sku: string;
  product_name: string;
  brand_name: string | null;
  category_path: string | null;
  color_name: string | null;
  size_code: string | null;
  quantity: number;
  unit_price: string;
  discount: string;
  tax_code: string;
  tax_rate: string;
  tax_amount: string;
  line_total: string;
  unit_cost: string | null;
  warehouse_id: string | null;
  qty_returned: number;
}

interface HistoryRow {
  id: string;
  from_status: StatusHistoryEntry['fromStatus'];
  to_status: StatusHistoryEntry['toStatus'];
  actor_type: StatusHistoryEntry['actorType'];
  actor_id: string | null;
  reason: string | null;
  created_at: Date;
}

function toHeader(r: OrderRow): Omit<OrderProps, 'items'> {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    orderNumber: r.order_number,
    userId: r.user_id,
    cartId: r.cart_id,
    customer: r.customer,
    billing: r.billing,
    status: r.status,
    paymentStatus: r.payment_status,
    paymentMethod: r.payment_method,
    fulfillmentType: r.fulfillment_type,
    shippingAddress: r.shipping_address,
    shippingLocation: r.shipping_lat === null || r.shipping_lng === null ? null : { lat: r.shipping_lat, lng: r.shipping_lng },
    shippingCity: r.shipping_city,
    shippingZoneId: r.shipping_zone_id,
    deliverySlotId: r.delivery_slot_id,
    sourceWarehouseId: r.source_warehouse_id,
    currency: r.currency,
    subtotal: r.subtotal,
    discountTotal: r.discount_total,
    shippingTotal: r.shipping_total,
    taxTotal: r.tax_total,
    giftCardTotal: r.gift_card_total,
    total: r.total,
    costTotal: r.cost_total,
    channel: r.channel,
    sellerId: r.seller_id,
    notes: r.notes,
    cancelReason: r.cancel_reason,
    placedAt: r.placed_at,
    paidAt: r.paid_at,
    shippedAt: r.shipped_at,
    deliveredAt: r.delivered_at,
    cancelledAt: r.cancelled_at,
    version: r.version,
    updatedAt: r.updated_at,
  };
}

function toItem(r: ItemRow): OrderItem {
  return {
    id: r.id,
    variantId: r.variant_id,
    productId: r.product_id,
    sku: r.sku,
    productName: r.product_name,
    brandName: r.brand_name,
    categoryPath: r.category_path,
    colorName: r.color_name,
    sizeCode: r.size_code,
    quantity: r.quantity,
    unitPrice: r.unit_price,
    discount: r.discount,
    taxCode: r.tax_code,
    taxRate: r.tax_rate,
    taxAmount: r.tax_amount,
    lineTotal: r.line_total,
    unitCost: r.unit_cost,
    warehouseId: r.warehouse_id,
    qtyReturned: r.qty_returned,
  };
}

/** Escapa % y _ para usar el texto del usuario dentro de un ILIKE. */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class PgOrderRepository extends OrderRepository {
  async insert(q: Queryable, order: Order): Promise<boolean> {
    const p = order.toJSON();
    const { rows } = await q.query<{ order_number: string }>(
      `INSERT INTO sales.orders
         (id, tenant_id, user_id, cart_id, customer, billing, status, payment_status, payment_method,
          fulfillment_type, shipping_address, shipping_location, shipping_city, shipping_zone_id,
          delivery_slot_id, source_warehouse_id, currency, subtotal, discount_total, shipping_total,
          tax_total, gift_card_total, total, cost_total, channel, seller_id, notes, placed_at, version, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11::jsonb,
               CASE WHEN $12::float8 IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_MakePoint($13::float8, $12::float8), 4326)::geography END,
               $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $29)
       ON CONFLICT (id) DO NOTHING
       RETURNING order_number`,
      [
        p.id,
        p.tenantId,
        p.userId,
        p.cartId,
        JSON.stringify(p.customer),
        JSON.stringify(p.billing),
        p.status,
        p.paymentStatus,
        p.paymentMethod,
        p.fulfillmentType,
        p.shippingAddress === null ? null : JSON.stringify(p.shippingAddress),
        p.shippingLocation?.lat ?? null,
        p.shippingLocation?.lng ?? null,
        p.shippingCity,
        p.shippingZoneId,
        p.deliverySlotId,
        p.sourceWarehouseId,
        p.currency,
        p.subtotal,
        p.discountTotal,
        p.shippingTotal,
        p.taxTotal,
        p.giftCardTotal,
        p.total,
        p.costTotal,
        p.channel,
        p.sellerId,
        p.notes,
        p.placedAt,
        p.version,
      ],
    );
    if (!rows[0]) return false;
    order.assignNumber(rows[0].order_number);

    const items = p.items;
    await q.query(
      `INSERT INTO sales.order_items
         (id, order_id, variant_id, product_id, sku, product_name, brand_name, category_path, color_name,
          size_code, quantity, unit_price, discount, tax_code, tax_rate, tax_amount, line_total, unit_cost,
          warehouse_id, qty_returned)
       SELECT t.id, $1, t.variant_id, t.product_id, t.sku, t.product_name, t.brand_name, t.category_path,
              t.color_name, t.size_code, t.quantity, t.unit_price, t.discount, t.tax_code, t.tax_rate,
              t.tax_amount, t.line_total, t.unit_cost, t.warehouse_id, 0
         FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::text[], $8::text[],
                     $9::text[], $10::text[], $11::int[], $12::numeric[], $13::numeric[], $14::text[],
                     $15::numeric[], $16::numeric[], $17::numeric[], $18::numeric[], $19::uuid[])
              AS t(id, variant_id, product_id, sku, product_name, brand_name, category_path, color_name,
                   size_code, quantity, unit_price, discount, tax_code, tax_rate, tax_amount, line_total,
                   unit_cost, warehouse_id)`,
      [
        p.id,
        items.map((i) => i.id),
        items.map((i) => i.variantId),
        items.map((i) => i.productId),
        items.map((i) => i.sku),
        items.map((i) => i.productName),
        items.map((i) => i.brandName),
        items.map((i) => i.categoryPath),
        items.map((i) => i.colorName),
        items.map((i) => i.sizeCode),
        items.map((i) => i.quantity),
        items.map((i) => i.unitPrice),
        items.map((i) => i.discount),
        items.map((i) => i.taxCode),
        items.map((i) => i.taxRate),
        items.map((i) => i.taxAmount),
        items.map((i) => i.lineTotal),
        items.map((i) => i.unitCost),
        items.map((i) => i.warehouseId),
      ],
    );
    return true;
  }

  async findById(q: Queryable, tenantId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<Order | null> {
    const { rows } = await q.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM sales.orders o
        WHERE o.tenant_id = $1 AND o.id = $2 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, id],
    );
    if (!rows[0]) return null;
    const { rows: items } = await q.query<ItemRow>(
      `SELECT id, order_id, variant_id, product_id, sku, product_name, brand_name, category_path, color_name,
              size_code, quantity, unit_price, discount, tax_code, tax_rate, tax_amount, line_total, unit_cost,
              warehouse_id, qty_returned
         FROM sales.order_items WHERE order_id = $1 ORDER BY product_name, sku`,
      [id],
    );
    return Order.restore({ ...toHeader(rows[0]), items: items.map(toItem) });
  }

  async list(q: Queryable, tenantId: string, f: OrderFilter): Promise<OrderSummary[]> {
    const where = ['o.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (f.statuses?.length) where.push(`o.status = ANY($${values.push(f.statuses)}::text[])`);
    if (f.paymentStatus) where.push(`o.payment_status = $${values.push(f.paymentStatus)}`);
    if (f.paymentMethod) where.push(`o.payment_method = $${values.push(f.paymentMethod)}`);
    if (f.fulfillmentType) where.push(`o.fulfillment_type = $${values.push(f.fulfillmentType)}`);
    if (f.channel) where.push(`o.channel = $${values.push(f.channel)}`);
    if (f.userId) where.push(`o.user_id = $${values.push(f.userId)}`);
    if (f.sellerId) where.push(`o.seller_id = $${values.push(f.sellerId)}`);
    if (f.from) where.push(`o.placed_at >= $${values.push(f.from)}`);
    if (f.to) where.push(`o.placed_at < $${values.push(f.to)}`);
    const search = f.search?.trim();
    if (search) {
      if (/^\d{1,18}$/.test(search)) where.push(`o.order_number = $${values.push(search)}::bigint`);
      else where.push(`o.customer->>'email' ILIKE $${values.push(`%${likeEscape(search.toLowerCase())}%`)}`);
    }
    const limit = values.push(f.limit);
    const offset = values.push(f.offset);
    const { rows } = await q.query<OrderRow & { item_count: number }>(
      `SELECT ${ORDER_COLUMNS},
              (SELECT count(*)::int FROM sales.order_items i WHERE i.order_id = o.id) AS item_count
         FROM sales.orders o
        WHERE ${where.join(' AND ')}
        ORDER BY o.placed_at DESC, o.order_number DESC
        LIMIT $${limit} OFFSET $${offset}`,
      values,
    );
    return rows.map((r) => ({ ...toHeader(r), itemCount: r.item_count }));
  }

  async update(q: Queryable, order: Order, expectedVersion: number): Promise<boolean> {
    const p = order.toJSON();
    const { rows } = await q.query<{ version: number; updated_at: Date }>(
      `UPDATE sales.orders
          SET status = $4, payment_status = $5, cancel_reason = $6, paid_at = $7, shipped_at = $8,
              delivered_at = $9, cancelled_at = $10, version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND version = $3
        RETURNING version, updated_at`,
      [p.tenantId, p.id, expectedVersion, p.status, p.paymentStatus, p.cancelReason, p.paidAt, p.shippedAt, p.deliveredAt, p.cancelledAt],
    );
    if (!rows[0]) return false;
    order.markPersisted(rows[0].version, rows[0].updated_at);
    return true;
  }

  async insertStatusChange(q: Queryable, c: StatusChange): Promise<void> {
    await q.query(
      `INSERT INTO sales.order_status_history (order_id, from_status, to_status, actor_type, actor_id, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [c.orderId, c.fromStatus, c.toStatus, c.actorType, c.actorId, c.reason, c.createdAt],
    );
  }

  async saveReturnedQuantities(q: Queryable, order: Order): Promise<void> {
    const items = order.toJSON().items;
    await q.query(
      `UPDATE sales.order_items i SET qty_returned = t.qty
         FROM unnest($2::uuid[], $3::int[]) AS t(id, qty)
        WHERE i.order_id = $1 AND i.id = t.id AND i.qty_returned <> t.qty`,
      [order.id, items.map((i) => i.id), items.map((i) => i.qtyReturned)],
    );
  }

  async listStatusHistory(q: Queryable, orderId: string): Promise<StatusHistoryEntry[]> {
    const { rows } = await q.query<HistoryRow>(
      `SELECT id::text, from_status, to_status, actor_type, actor_id, reason, created_at
         FROM sales.order_status_history WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId],
    );
    return rows.map((r) => ({
      id: r.id,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      actorType: r.actor_type,
      actorId: r.actor_id,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  async findDeliveredLines(q: Queryable, tenantId: string, userId: string, productIds: string[]): Promise<DeliveredLine[]> {
    if (productIds.length === 0) return [];
    const { rows } = await q.query<{ order_id: string; order_item_id: string; product_id: string; variant_id: string; delivered_at: Date }>(
      `SELECT o.id AS order_id, i.id AS order_item_id, i.product_id, i.variant_id, o.delivered_at
         FROM sales.orders o JOIN sales.order_items i ON i.order_id = o.id
        WHERE o.tenant_id = $1 AND o.user_id = $2 AND o.delivered_at IS NOT NULL
          AND o.status IN ('delivered', 'partially_returned')
          AND i.product_id = ANY($3::uuid[]) AND i.qty_returned < i.quantity
        ORDER BY o.delivered_at DESC, i.id`,
      [tenantId, userId, productIds],
    );
    return rows.map((r) => ({
      orderId: r.order_id,
      orderItemId: r.order_item_id,
      productId: r.product_id,
      variantId: r.variant_id,
      deliveredAt: r.delivered_at,
    }));
  }

  async listFulfillmentQueue(q: Queryable, tenantId: string, f: FulfillmentQueueFilter): Promise<FulfillmentQueueEntry[]> {
    const where = ['o.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    // to_pick: los estados desde los que la máquina permite pasar a preparing (pagado, o contra entrega sin pagar).
    where.push(f.stage === 'picking' ? `o.status = 'preparing'` : `(o.status = 'paid' OR (o.status = 'created' AND o.payment_method = 'cod'))`);
    if (f.warehouseId) where.push(`o.source_warehouse_id = $${values.push(f.warehouseId)}`);
    const limit = values.push(f.limit);
    const { rows } = await q.query<OrderRow & { item_count: number; unit_count: number }>(
      `SELECT ${ORDER_COLUMNS}, c.item_count, c.unit_count
         FROM sales.orders o
         CROSS JOIN LATERAL (SELECT count(*)::int AS item_count, COALESCE(sum(i.quantity), 0)::int AS unit_count
                               FROM sales.order_items i WHERE i.order_id = o.id) c
        WHERE ${where.join(' AND ')}
        ORDER BY o.placed_at, o.order_number
        LIMIT $${limit}`,
      values,
    );
    return rows.map((r) => ({ ...toHeader(r), itemCount: r.item_count, unitCount: r.unit_count }));
  }

  async countActiveByUser(q: Queryable, tenantId: string, userId: string): Promise<number> {
    const { rows } = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sales.orders WHERE tenant_id = $1 AND user_id = $2 AND status <> 'cancelled'`,
      [tenantId, userId],
    );
    return rows[0].n;
  }
}
