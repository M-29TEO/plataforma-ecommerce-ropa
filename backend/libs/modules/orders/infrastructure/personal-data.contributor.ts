import { Injectable, OnModuleInit } from '@nestjs/common';
import { AnonymizationResult, Database, DataSubject, PersonalDataContributor, PersonalDataRegistry } from '../../../shared-kernel';

/** Estados en los que el pedido terminó (order-status.ts: sin más transiciones salvo devoluciones). */
const FINAL_ORDER_STATUSES = ['delivered', 'cancelled', 'returned', 'partially_returned'];
/** Estados finales de una devolución (return.ts: TRANSITIONS sin salida). */
const FINAL_RETURN_STATUSES = ['rejected', 'refunded', 'exchanged', 'closed'];

/**
 * Derechos LOPDP del titular en sales.orders, order_items y returns (schema sales, módulo Pedidos).
 *
 * Exporta: pedidos (número, estados, método de pago, tipo de entrega, totales, fecha, snapshots de
 * cliente, facturación y dirección, ítems) y devoluciones (RMA, tipo, estado, motivo, notas).
 * Bloquea: pedidos o devoluciones en curso (hace falta el contacto para entregar o reembolsar).
 * Anonimiza: los snapshots del pedido. La forma nueva respeta a quienes los leen:
 *   - customer: name y email siguen siendo string (Soporte hace customer.email.trim(), Facturación
 *     customer.name.trim()); el email es el mismo seudónimo que IAM, que no coincide con nadie.
 *   - billing: consumidor final (07 / 9999999999999), como lo resuelve Facturación sin identificación.
 *   - shipping_address: solo city, province y neighborhood (Reportes agrupa por barrio); sin calle,
 *     número, referencia ni coordenadas. shipping_location = NULL (shipping_city se queda: Reportes).
 *   - returns.customer_notes = NULL.
 * Conserva: montos, productos, fechas y ciudad de los pedidos, para contabilidad y reportes.
 */
@Injectable()
export class OrdersPersonalDataContributor extends PersonalDataContributor implements OnModuleInit {
  override readonly section = 'pedidos';

  constructor(
    private readonly registry: PersonalDataRegistry,
    private readonly db: Database,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  override async resolve(s: DataSubject): Promise<Partial<Pick<DataSubject, 'email' | 'orderIds'>>> {
    const { rows } = await this.db.query<{ id: string }>(`SELECT id FROM sales.orders WHERE tenant_id = $1 AND user_id = $2 ORDER BY placed_at`, [
      s.tenantId,
      s.userId,
    ]);
    return { orderIds: rows.map((r) => r.id) };
  }

  override async exportData(s: DataSubject): Promise<unknown> {
    const { rows: orders } = await this.db.query<{
      id: string;
      order_number: string;
      status: string;
      payment_status: string;
      payment_method: string;
      fulfillment_type: string;
      currency: string;
      subtotal: string;
      discount_total: string;
      shipping_total: string;
      tax_total: string;
      gift_card_total: string;
      total: string;
      placed_at: Date;
      delivered_at: Date | null;
      cancelled_at: Date | null;
      customer: Record<string, unknown>;
      billing: Record<string, unknown>;
      shipping_address: Record<string, unknown> | null;
    }>(
      `SELECT id, order_number, status, payment_status, payment_method, fulfillment_type, currency, subtotal, discount_total,
              shipping_total, tax_total, gift_card_total, total, placed_at, delivered_at, cancelled_at, customer, billing,
              shipping_address
         FROM sales.orders WHERE tenant_id = $1 AND user_id = $2
        ORDER BY placed_at, order_number`,
      [s.tenantId, s.userId],
    );
    const ids = orders.map((o) => o.id);
    const { rows: items } = ids.length
      ? await this.db.query<{
          order_id: string;
          sku: string;
          product_id: string;
          variant_id: string;
          product_name: string;
          brand_name: string | null;
          color_name: string | null;
          size_code: string | null;
          quantity: number;
          unit_price: string;
          discount: string;
          tax_amount: string;
          line_total: string;
          qty_returned: number;
        }>(
          `SELECT order_id, sku, product_id, variant_id, product_name, brand_name, color_name, size_code, quantity, unit_price,
                  discount, tax_amount, line_total, qty_returned
             FROM sales.order_items WHERE order_id = ANY($1::uuid[])
            ORDER BY product_name, sku`,
          [ids],
        )
      : { rows: [] };
    const { rows: returns } = await this.db.query<{
      order_number: string;
      rma_number: string;
      type: string;
      status: string;
      resolution: string | null;
      reason: string;
      customer_notes: string | null;
      refund_amount: string | null;
      created_at: Date;
      closed_at: Date | null;
    }>(
      `SELECT o.order_number, r.rma_number, r.type, r.status, r.resolution, r.reason, r.customer_notes, r.refund_amount,
              r.created_at, r.closed_at
         FROM sales.returns r
         JOIN sales.orders o ON o.id = r.order_id AND o.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND o.user_id = $2
        ORDER BY r.created_at, r.rma_number`,
      [s.tenantId, s.userId],
    );

    return {
      orders: orders.map((o) => ({
        id: o.id,
        orderNumber: o.order_number,
        status: o.status,
        paymentStatus: o.payment_status,
        paymentMethod: o.payment_method,
        fulfillmentType: o.fulfillment_type,
        currency: o.currency,
        subtotal: o.subtotal,
        discountTotal: o.discount_total,
        shippingTotal: o.shipping_total,
        taxTotal: o.tax_total,
        giftCardTotal: o.gift_card_total,
        total: o.total,
        placedAt: iso(o.placed_at),
        deliveredAt: iso(o.delivered_at),
        cancelledAt: iso(o.cancelled_at),
        customer: o.customer,
        billing: o.billing,
        shippingAddress: o.shipping_address,
        items: items
          .filter((i) => i.order_id === o.id)
          .map((i) => ({
            sku: i.sku,
            productId: i.product_id,
            variantId: i.variant_id,
            productName: i.product_name,
            brandName: i.brand_name,
            colorName: i.color_name,
            sizeCode: i.size_code,
            quantity: i.quantity,
            unitPrice: i.unit_price,
            discount: i.discount,
            taxAmount: i.tax_amount,
            lineTotal: i.line_total,
            qtyReturned: i.qty_returned,
          })),
      })),
      returns: returns.map((r) => ({
        orderNumber: r.order_number,
        rmaNumber: r.rma_number,
        type: r.type,
        status: r.status,
        resolution: r.resolution,
        reason: r.reason,
        customerNotes: r.customer_notes,
        refundAmount: r.refund_amount,
        createdAt: iso(r.created_at),
        closedAt: iso(r.closed_at),
      })),
    };
  }

  override async blockers(s: DataSubject): Promise<string[]> {
    const { rows: orders } = await this.db.query<{ order_number: string }>(
      `SELECT order_number FROM sales.orders
        WHERE tenant_id = $1 AND user_id = $2 AND status <> ALL($3::text[])
        ORDER BY order_number`,
      [s.tenantId, s.userId, FINAL_ORDER_STATUSES],
    );
    const { rows: returns } = await this.db.query<{ rma_number: string }>(
      `SELECT r.rma_number
         FROM sales.returns r
         JOIN sales.orders o ON o.id = r.order_id AND o.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND o.user_id = $2 AND r.status <> ALL($3::text[])
        ORDER BY r.rma_number`,
      [s.tenantId, s.userId, FINAL_RETURN_STATUSES],
    );
    return [...orders.map((o) => `Pedido #${o.order_number} en curso`), ...returns.map((r) => `Devolución ${r.rma_number} en curso`)];
  }

  override async anonymize(s: DataSubject): Promise<AnonymizationResult> {
    const params = [s.tenantId, s.userId];
    const orders = await this.db.query(
      `UPDATE sales.orders
          SET customer = jsonb_build_object(
                'name', 'Cliente anonimizado',
                'email', 'anonimizado+' || user_id || '@anonimizado.invalid',
                'anonymized', true),
              billing = jsonb_build_object(
                'name', 'CONSUMIDOR FINAL', 'idType', '07', 'idNumber', '9999999999999', 'anonymized', true),
              shipping_address = CASE WHEN shipping_address IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
                'city', shipping_address->'city',
                'province', shipping_address->'province',
                'neighborhood', shipping_address->'neighborhood')) END,
              shipping_location = NULL,
              updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2`,
      params,
    );
    const returns = await this.db.query(
      `UPDATE sales.returns SET customer_notes = NULL
        WHERE tenant_id = $1 AND customer_notes IS NOT NULL
          AND order_id IN (SELECT id FROM sales.orders WHERE tenant_id = $1 AND user_id = $2)`,
      params,
    );
    return {
      affected: (orders.rowCount ?? 0) + (returns.rowCount ?? 0),
      retained: ['Pedidos (montos, productos, fechas y ciudad): contabilidad y reportes, sin datos de contacto'],
    };
  }
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}
