import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { RiderAppRepository, RiderProfile } from '../application/rider-app-ports';
import { EarningsDelivery } from '../domain/earnings';
import { ShiftRecord, ShiftStatus } from '../domain/shift';

interface ShiftRow {
  id: string;
  rider_id: string;
  zone_id: string | null;
  starts_at: Date;
  ends_at: Date;
  status: ShiftStatus;
  checked_in_at: Date | null;
}

const SHIFT_COLUMNS = 'id, rider_id, zone_id, starts_at, ends_at, status, checked_in_at';

function toShift(r: ShiftRow): ShiftRecord {
  return { id: r.id, riderId: r.rider_id, zoneId: r.zone_id, startsAt: r.starts_at, endsAt: r.ends_at, status: r.status, checkedInAt: r.checked_in_at };
}

@Injectable()
export class PgRiderAppRepository extends RiderAppRepository {
  async findProfile(q: Queryable, tenantId: string, userId: string): Promise<RiderProfile | null> {
    const { rows } = await q.query<{
      id: string;
      user_id: string;
      tenant_id: string;
      vehicle_type: string;
      plate: string | null;
      status: string;
      presence: string;
      rating_avg: string;
      rating_count: number;
      cod_balance: string;
      cod_limit: string;
      max_concurrent: number;
      home_zone_id: string | null;
      ntfy_topic: string | null;
      commission_scheme: unknown;
    }>(
      `SELECT id, user_id, tenant_id, vehicle_type, plate, status, presence, to_char(rating_avg, 'FM0.00') AS rating_avg, rating_count,
              cod_balance, cod_limit, max_concurrent, home_zone_id, ntfy_topic, commission_scheme
         FROM logistics.riders WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      riderId: r.id,
      userId: r.user_id,
      tenantId: r.tenant_id,
      vehicleType: r.vehicle_type,
      plate: r.plate,
      status: r.status,
      presence: r.presence,
      ratingAvg: r.rating_avg,
      ratingCount: r.rating_count,
      codBalance: r.cod_balance,
      codLimit: r.cod_limit,
      maxConcurrent: r.max_concurrent,
      homeZoneId: r.home_zone_id,
      ntfyTopic: r.ntfy_topic,
      commissionScheme: r.commission_scheme,
    };
  }

  async ensureNtfyTopic(q: Queryable, riderId: string, candidate: string): Promise<string> {
    await q.query(`UPDATE logistics.riders SET ntfy_topic = $2 WHERE id = $1 AND ntfy_topic IS NULL`, [riderId, candidate]);
    const { rows } = await q.query<{ ntfy_topic: string }>(`SELECT ntfy_topic FROM logistics.riders WHERE id = $1`, [riderId]);
    return rows[0].ntfy_topic;
  }

  async lockRider(q: Queryable, riderId: string): Promise<void> {
    await q.query(`SELECT 1 FROM logistics.riders WHERE id = $1 FOR UPDATE`, [riderId]);
  }

  async findActiveShift(q: Queryable, riderId: string): Promise<ShiftRecord | null> {
    const { rows } = await q.query<ShiftRow>(
      `SELECT ${SHIFT_COLUMNS} FROM logistics.rider_shifts WHERE rider_id = $1 AND status = 'active' ORDER BY starts_at DESC LIMIT 1`,
      [riderId],
    );
    return rows[0] ? toShift(rows[0]) : null;
  }

  async listScheduledCovering(q: Queryable, riderId: string, now: Date): Promise<ShiftRecord[]> {
    const { rows } = await q.query<ShiftRow>(
      `SELECT ${SHIFT_COLUMNS} FROM logistics.rider_shifts
        WHERE rider_id = $1 AND status = 'scheduled' AND starts_at <= $2 AND ends_at > $2 ORDER BY starts_at`,
      [riderId, now],
    );
    return rows.map(toShift);
  }

  async activateShift(q: Queryable, id: string, now: Date): Promise<ShiftRecord> {
    const { rows } = await q.query<ShiftRow>(
      `UPDATE logistics.rider_shifts SET status = 'active', checked_in_at = $2 WHERE id = $1 RETURNING ${SHIFT_COLUMNS}`,
      [id, now],
    );
    return toShift(rows[0]);
  }

  async insertActiveShift(q: Queryable, s: { riderId: string; zoneId: string | null; startsAt: Date; endsAt: Date; checkedInAt: Date }): Promise<ShiftRecord> {
    const { rows } = await q.query<ShiftRow>(
      `INSERT INTO logistics.rider_shifts (rider_id, zone_id, starts_at, ends_at, status, checked_in_at)
       VALUES ($1, $2, $3, $4, 'active', $5) RETURNING ${SHIFT_COLUMNS}`,
      [s.riderId, s.zoneId, s.startsAt, s.endsAt, s.checkedInAt],
    );
    return toShift(rows[0]);
  }

  async completeShift(q: Queryable, id: string, now: Date): Promise<ShiftRecord> {
    const { rows } = await q.query<ShiftRow>(
      `UPDATE logistics.rider_shifts SET status = 'completed', ends_at = $2 WHERE id = $1 RETURNING ${SHIFT_COLUMNS}`,
      [id, now],
    );
    return toShift(rows[0]);
  }

  async setPresence(q: Queryable, riderId: string, presence: string): Promise<void> {
    await q.query(`UPDATE logistics.riders SET presence = $2 WHERE id = $1`, [riderId, presence]);
  }

  async listDelivered(q: Queryable, riderId: string, from: Date, to: Date): Promise<EarningsDelivery[]> {
    const { rows } = await q.query<{
      id: string;
      order_id: string;
      delivered_at: Date;
      distance_m: number | null;
      cod_amount: string;
      cod_collected: string | null;
      cod_method: string | null;
    }>(
      `SELECT id, order_id, delivered_at, distance_m, cod_amount, cod_collected, cod_method
         FROM logistics.shipments
        WHERE rider_id = $1 AND carrier_type = 'rider' AND status = 'delivered' AND delivered_at >= $2 AND delivered_at < $3
        ORDER BY delivered_at DESC, id`,
      [riderId, from, to],
    );
    return rows.map((r) => ({
      shipmentId: r.id,
      orderId: r.order_id,
      deliveredAt: r.delivered_at,
      distanceM: r.distance_m,
      codAmount: r.cod_amount,
      codCollected: r.cod_collected,
      codMethod: r.cod_method,
    }));
  }
}
