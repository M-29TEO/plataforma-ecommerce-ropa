import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { HandoffRepository, NewPickupShipment, OutboundShipmentInfo } from '../application/handoff-ports';

@Injectable()
export class PgHandoffRepository extends HandoffRepository {
  async lockOrder(q: Queryable, orderId: string): Promise<void> {
    // Candado de la transacción por pedido (no toca sales.orders: es otro schema).
    await q.query(`SELECT pg_advisory_xact_lock(hashtext('logistics.handoff:' || $1::text))`, [orderId]);
  }

  async listOutbound(q: Queryable, tenantId: string, orderIds: string[]): Promise<OutboundShipmentInfo[]> {
    if (orderIds.length === 0) return [];
    const { rows } = await q.query<{
      id: string;
      order_id: string;
      carrier_type: string;
      status: string;
      starts_at: Date | null;
      ends_at: Date | null;
    }>(
      `SELECT DISTINCT ON (s.order_id) s.id, s.order_id, s.carrier_type, s.status, sl.starts_at, sl.ends_at
         FROM logistics.shipments s
         LEFT JOIN logistics.delivery_slots sl ON sl.id = s.delivery_slot_id
        WHERE s.tenant_id = $1 AND s.order_id = ANY($2::uuid[]) AND s.direction = 'outbound' AND s.status <> 'cancelled'
        ORDER BY s.order_id, s.created_at DESC, s.id`,
      [tenantId, orderIds],
    );
    return rows.map((r) => ({
      shipmentId: r.id,
      orderId: r.order_id,
      carrierType: r.carrier_type,
      status: r.status,
      slot: r.starts_at && r.ends_at ? { startsAt: r.starts_at, endsAt: r.ends_at } : null,
    }));
  }

  async insertPickupReady(q: Queryable, s: NewPickupShipment): Promise<string> {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO logistics.shipments
         (tenant_id, order_id, direction, carrier_type, tracking_token, status, origin_warehouse_id, destination,
          destination_location, weight_g, price_charged, cod_amount)
       VALUES ($1, $2, 'outbound', 'pickup', $3, 'ready_for_pickup', $4, $5::jsonb,
               ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography, 0, 0, $8)
       RETURNING id`,
      [s.tenantId, s.orderId, s.trackingToken, s.warehouseId, JSON.stringify(s.destination), s.location.lng, s.location.lat, s.codAmount],
    );
    await q.query(
      `INSERT INTO logistics.shipment_events (shipment_id, status, description, source, occurred_at)
       VALUES ($1, 'ready_for_pickup', $2, 'staff', now())`,
      [rows[0].id, s.description],
    );
    return rows[0].id;
  }
}
