import { Injectable } from '@nestjs/common';
import { isUniqueViolation, Queryable } from '../../../shared-kernel';
import { CancelledShipment, NewPendingShipment, NewReverseShipment, ShipmentDirection, ShipmentRepository, ShipmentSummary } from '../application/ports';

/** Índice único parcial de la migración 1759000000008: un envío vigente por devolución y dirección. */
const ONE_PER_RETURN_DIRECTION = 'ux_ship_return_direction';

const SUMMARY_COLUMNS = `id, order_id, return_id, direction, carrier_type, status, origin_warehouse_id, zone_id, delivery_slot_id,
  courier_service_id, price_charged, tracking_token, delivered_at`;

interface SummaryRow {
  id: string;
  order_id: string;
  return_id: string | null;
  direction: ShipmentDirection;
  carrier_type: string;
  status: string;
  origin_warehouse_id: string | null;
  zone_id: string | null;
  delivery_slot_id: string | null;
  courier_service_id: string | null;
  price_charged: string;
  tracking_token: string;
  delivered_at: Date | null;
}

function toSummary(r: SummaryRow): ShipmentSummary {
  return {
    id: r.id,
    orderId: r.order_id,
    returnId: r.return_id,
    direction: r.direction,
    carrierType: r.carrier_type,
    status: r.status,
    originWarehouseId: r.origin_warehouse_id,
    zoneId: r.zone_id,
    deliverySlotId: r.delivery_slot_id,
    courierServiceId: r.courier_service_id,
    priceCharged: r.price_charged,
    trackingToken: r.tracking_token,
    deliveredAt: r.delivered_at,
  };
}

@Injectable()
export class PgShipmentRepository extends ShipmentRepository {
  async insertPending(q: Queryable, s: NewPendingShipment): Promise<string> {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO logistics.shipments
         (tenant_id, order_id, carrier_type, courier_service_id, tracking_token, status, origin_warehouse_id,
          destination, destination_location, zone_id, delivery_slot_id, distance_m, weight_g, volume_cm3,
          price_charged, carrier_cost, cod_amount, eta)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7::jsonb, ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography,
               $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING id`,
      [
        s.tenantId,
        s.orderId,
        s.carrierType,
        s.courierServiceId,
        s.trackingToken,
        s.originWarehouseId,
        JSON.stringify(s.destination),
        s.destinationLocation.lng,
        s.destinationLocation.lat,
        s.zoneId,
        s.deliverySlotId,
        s.distanceM,
        s.weightG,
        s.volumeCm3,
        s.priceCharged,
        s.carrierCost,
        s.codAmount,
        s.eta,
      ],
    );
    const id = rows[0].id;
    await q.query(
      `INSERT INTO logistics.shipment_events (shipment_id, status, description, source, occurred_at)
       VALUES ($1, 'pending', 'Envío creado en el checkout', 'system', now())`,
      [id],
    );
    return id;
  }

  async findByOrder(q: Queryable, tenantId: string, orderId: string): Promise<ShipmentSummary[]> {
    const { rows } = await q.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM logistics.shipments WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at`,
      [tenantId, orderId],
    );
    return rows.map(toSummary);
  }

  async cancelPendingByOrder(
    q: Queryable,
    tenantId: string,
    orderId: string,
    reason: string,
  ): Promise<CancelledShipment[]> {
    const { rows } = await q.query<{ id: string; delivery_slot_id: string | null; carrier_type: string; tracking_token: string }>(
      `UPDATE logistics.shipments SET status = 'cancelled', updated_at = now(), version = version + 1
        WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending' AND direction = 'outbound'
        RETURNING id, delivery_slot_id, carrier_type, tracking_token`,
      [tenantId, orderId],
    );
    for (const r of rows) {
      await q.query(
        `INSERT INTO logistics.shipment_events (shipment_id, status, description, source, occurred_at)
         VALUES ($1, 'cancelled', $2, 'system', now())`,
        [r.id, reason],
      );
    }
    return rows.map((r) => ({ id: r.id, deliverySlotId: r.delivery_slot_id, carrierType: r.carrier_type, trackingToken: r.tracking_token }));
  }

  async insertReverse(q: Queryable, s: NewReverseShipment): Promise<string | null> {
    let id: string;
    try {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO logistics.shipments
           (tenant_id, order_id, return_id, direction, carrier_type, tracking_token, status, origin_warehouse_id,
            destination, destination_location, weight_g, packages, price_charged, cod_amount)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8::jsonb,
                 CASE WHEN $9::float8 IS NULL THEN NULL
                      ELSE ST_SetSRID(ST_MakePoint($10::float8, $9::float8), 4326)::geography END,
                 $11, 1, 0, 0)
         RETURNING id`,
        [
          s.tenantId,
          s.orderId,
          s.returnId,
          s.direction,
          s.carrierType,
          s.trackingToken,
          s.originWarehouseId,
          JSON.stringify(s.destination),
          s.destinationLocation?.lat ?? null,
          s.destinationLocation?.lng ?? null,
          s.weightG,
        ],
      );
      id = rows[0].id;
    } catch (error) {
      if (isUniqueViolation(error, ONE_PER_RETURN_DIRECTION)) return null;
      throw error;
    }
    await q.query(
      `INSERT INTO logistics.shipment_items (shipment_id, order_item_id, quantity)
       SELECT $1, t.order_item_id, sum(t.quantity) FROM unnest($2::uuid[], $3::int[]) AS t(order_item_id, quantity)
        GROUP BY t.order_item_id`,
      [id, s.items.map((i) => i.orderItemId), s.items.map((i) => i.quantity)],
    );
    await q.query(
      `INSERT INTO logistics.shipment_events (shipment_id, status, description, source, occurred_at)
       VALUES ($1, 'pending', $2, 'system', now())`,
      [id, s.description],
    );
    return id;
  }

  async findByReturn(q: Queryable, tenantId: string, returnId: string, direction: 'return' | 'exchange'): Promise<ShipmentSummary | null> {
    const { rows } = await q.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM logistics.shipments
        WHERE tenant_id = $1 AND return_id = $2 AND direction = $3 AND status <> 'cancelled'
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, returnId, direction],
    );
    return rows[0] ? toSummary(rows[0]) : null;
  }

  async markReturnDelivered(q: Queryable, tenantId: string, returnId: string, warehouseId: string | null): Promise<ShipmentSummary | null> {
    const { rows } = await q.query<SummaryRow>(
      `UPDATE logistics.shipments
          SET status = 'delivered', delivered_at = now(), origin_warehouse_id = COALESCE($3, origin_warehouse_id),
              updated_at = now(), version = version + 1
        WHERE tenant_id = $1 AND return_id = $2 AND direction = 'return' AND status NOT IN ('delivered', 'cancelled')
        RETURNING ${SUMMARY_COLUMNS}`,
      [tenantId, returnId, warehouseId],
    );
    if (!rows[0]) return this.findByReturn(q, tenantId, returnId, 'return');
    await q.query(
      `INSERT INTO logistics.shipment_events (shipment_id, status, description, source, occurred_at)
       VALUES ($1, 'delivered', 'Devolución recibida en bodega', 'staff', now())`,
      [rows[0].id],
    );
    return toSummary(rows[0]);
  }
}
