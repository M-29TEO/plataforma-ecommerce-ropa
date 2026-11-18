import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { ActiveShipmentRow, LiveOpsRepository, LiveRiderRow, ShipmentListFilter, ShipmentListRow } from '../application/live-ops-ports';
import { RIDER_ACTIVE_STATUSES, RiderPresence } from '../domain/tracking';

interface RiderRow {
  id: string;
  user_id: string;
  vehicle_type: string;
  plate: string | null;
  status: string;
  presence: string;
  cod_balance: string;
  cod_limit: string;
  rating_avg: string;
  lat: number | null;
  lng: number | null;
  heading: number | null;
  speed_kmh: number | null;
  recorded_at: Date | null;
}

interface ShipmentRow {
  id: string;
  order_id: string;
  direction: string;
  carrier_type: string;
  status: string;
  zone_id: string | null;
  rider_id: string | null;
  cod_amount: string;
  slot_starts_at: Date | null;
  slot_ends_at: Date | null;
  created_at: Date;
  destination: Record<string, unknown> | null;
  dest_lat: number | null;
  dest_lng: number | null;
  total: string;
}

@Injectable()
export class PgLiveOpsRepository extends LiveOpsRepository {
  async listRiders(q: Queryable, tenantId: string, since: Date): Promise<LiveRiderRow[]> {
    // LATERAL + LIMIT 1 por motorizado: recorre ix_rlh (rider_id, recorded_at DESC) y, con el
    // límite de tiempo, solo las particiones del último mes que pueden tener filas.
    const { rows } = await q.query<RiderRow>(
      `SELECT r.id, r.user_id, r.vehicle_type, r.plate, r.status, r.presence, r.cod_balance, r.cod_limit,
              to_char(r.rating_avg, 'FM0.00') AS rating_avg, l.lat, l.lng, l.heading, l.speed_kmh, l.recorded_at
         FROM logistics.riders r
         LEFT JOIN LATERAL (
           SELECT ST_Y(h.location::geometry) AS lat, ST_X(h.location::geometry) AS lng, h.heading, h.speed_kmh, h.recorded_at
             FROM logistics.rider_location_history h
            WHERE h.rider_id = r.id AND h.recorded_at >= $2
            ORDER BY h.recorded_at DESC
            LIMIT 1
         ) l ON true
        WHERE r.tenant_id = $1 AND r.status <> 'inactive'
        ORDER BY r.created_at, r.id`,
      [tenantId, since],
    );
    return rows.map((r) => ({
      riderId: r.id,
      userId: r.user_id,
      vehicleType: r.vehicle_type,
      plate: r.plate,
      status: r.status,
      presence: r.presence,
      codBalance: r.cod_balance,
      codLimit: r.cod_limit,
      ratingAvg: r.rating_avg,
      lastLocation:
        r.recorded_at && r.lat !== null && r.lng !== null
          ? { lat: r.lat, lng: r.lng, heading: r.heading, speedKmh: r.speed_kmh, recordedAt: r.recorded_at.toISOString() }
          : null,
    }));
  }

  async listActiveShipments(q: Queryable, tenantId: string, riderIds: string[]): Promise<ActiveShipmentRow[]> {
    if (riderIds.length === 0) return [];
    const { rows } = await q.query<{ id: string; order_id: string; rider_id: string; status: string; dest_lat: number | null; dest_lng: number | null }>(
      `SELECT id, order_id, rider_id, status,
              ST_Y(destination_location::geometry) AS dest_lat, ST_X(destination_location::geometry) AS dest_lng
         FROM logistics.shipments
        WHERE tenant_id = $1 AND rider_id = ANY($2::uuid[]) AND status = ANY($3::text[])
        ORDER BY assigned_at, created_at`,
      [tenantId, riderIds, RIDER_ACTIVE_STATUSES],
    );
    return rows.map((r) => ({
      shipmentId: r.id,
      orderId: r.order_id,
      riderId: r.rider_id,
      status: r.status,
      dropoff: r.dest_lat !== null && r.dest_lng !== null ? { lat: r.dest_lat, lng: r.dest_lng } : null,
    }));
  }

  async listShipments(q: Queryable, tenantId: string, f: ShipmentListFilter): Promise<{ rows: ShipmentListRow[]; total: number }> {
    const where = ['s.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (f.statuses?.length) where.push(`s.status = ANY($${values.push(f.statuses)}::text[])`);
    if (f.carrierType) where.push(`s.carrier_type = $${values.push(f.carrierType)}`);
    if (f.zoneId) where.push(`s.zone_id = $${values.push(f.zoneId)}`);
    if (f.riderId) where.push(`s.rider_id = $${values.push(f.riderId)}`);
    // FIFO: lo más antiguo primero (la cola de despacho atiende en orden de llegada).
    const { rows } = await q.query<ShipmentRow>(
      `SELECT s.id, s.order_id, s.direction, s.carrier_type, s.status, s.zone_id, s.rider_id, s.cod_amount,
              sl.starts_at AS slot_starts_at, sl.ends_at AS slot_ends_at, s.created_at, s.destination,
              ST_Y(s.destination_location::geometry) AS dest_lat, ST_X(s.destination_location::geometry) AS dest_lng,
              count(*) OVER () AS total
         FROM logistics.shipments s
         LEFT JOIN logistics.delivery_slots sl ON sl.id = s.delivery_slot_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.created_at, s.id
        LIMIT $${values.push(f.limit)} OFFSET $${values.push(f.offset)}`,
      values,
    );
    let total = rows[0] ? Number(rows[0].total) : 0;
    if (rows.length === 0 && f.offset > 0) {
      // Página fuera de rango: el total igual sirve para el paginador.
      const c = await q.query<{ n: string }>(`SELECT count(*) AS n FROM logistics.shipments s WHERE ${where.join(' AND ')}`, values.slice(0, -2));
      total = Number(c.rows[0].n);
    }
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        orderId: r.order_id,
        direction: r.direction,
        carrierType: r.carrier_type,
        status: r.status,
        zoneId: r.zone_id,
        riderId: r.rider_id,
        codAmount: r.cod_amount,
        slot: r.slot_starts_at && r.slot_ends_at ? { startsAt: r.slot_starts_at.toISOString(), endsAt: r.slot_ends_at.toISOString() } : null,
        createdAt: r.created_at.toISOString(),
        destination: r.destination ?? {},
        dropoff: r.dest_lat !== null && r.dest_lng !== null ? { lat: r.dest_lat, lng: r.dest_lng } : null,
      })),
    };
  }

  async setPresence(q: Queryable, tenantId: string, userId: string, presence: RiderPresence): Promise<{ riderId: string } | null> {
    const { rows } = await q.query<{ id: string }>(
      `UPDATE logistics.riders SET presence = $3 WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' RETURNING id`,
      [tenantId, userId, presence],
    );
    return rows[0] ? { riderId: rows[0].id } : null;
  }
}
