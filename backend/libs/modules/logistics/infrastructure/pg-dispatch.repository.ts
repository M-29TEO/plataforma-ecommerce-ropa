import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { ClosedOffer, DispatchRepository, NewOffer, OfferRecord } from '../application/rider-app-ports';
import { DispatchCandidate, OfferResponse } from '../domain/dispatch';
import { RIDER_ACTIVE_STATUSES } from '../domain/tracking';

interface OfferRow {
  id: string;
  shipment_id: string;
  rider_id: string;
  score: string;
  offered_at: Date;
  expires_at: Date;
  response: OfferResponse | null;
  responded_at: Date | null;
}

const OFFER_COLUMNS = 'id::text AS id, shipment_id, rider_id, score, offered_at, expires_at, response, responded_at';

function toOffer(r: OfferRow): OfferRecord {
  return {
    id: r.id,
    shipmentId: r.shipment_id,
    riderId: r.rider_id,
    score: r.score,
    offeredAt: r.offered_at,
    expiresAt: r.expires_at,
    response: r.response,
    respondedAt: r.responded_at,
  };
}

interface ClosedRow {
  id: string;
  shipment_id: string;
  rider_id: string;
  tenant_id: string;
}

const toClosed = (r: ClosedRow): ClosedOffer => ({ offerId: r.id, shipmentId: r.shipment_id, riderId: r.rider_id, tenantId: r.tenant_id });

@Injectable()
export class PgDispatchRepository extends DispatchRepository {
  async listCandidates(q: Queryable, tenantId: string, shipmentId: string, since: Date, now: Date): Promise<DispatchCandidate[]> {
    // Última posición con LATERAL + LIMIT 1 (ix_rlh); la flota de un tenant es de decenas.
    const { rows } = await q.query<{
      id: string;
      presence: string;
      max_concurrent: number;
      rating_avg: string;
      cod_limit: string;
      cod_balance: string;
      active: number;
      lat: number;
      lng: number;
      recorded_at: Date;
    }>(
      `SELECT r.id, r.presence, r.max_concurrent, r.rating_avg::text AS rating_avg, r.cod_limit, r.cod_balance,
              (SELECT count(*)::int FROM logistics.shipments a WHERE a.rider_id = r.id AND a.status = ANY($4::text[])) AS active,
              l.lat, l.lng, l.recorded_at
         FROM logistics.riders r
         JOIN LATERAL (
           SELECT ST_Y(h.location::geometry) AS lat, ST_X(h.location::geometry) AS lng, h.recorded_at
             FROM logistics.rider_location_history h
            WHERE h.rider_id = r.id AND h.recorded_at >= $3
            ORDER BY h.recorded_at DESC
            LIMIT 1
         ) l ON true
        WHERE r.tenant_id = $1 AND r.status = 'active' AND r.presence IN ('available', 'busy')
          AND EXISTS (SELECT 1 FROM logistics.rider_shifts sh WHERE sh.rider_id = r.id AND sh.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM logistics.dispatch_offers o WHERE o.shipment_id = $2 AND o.rider_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM logistics.dispatch_offers o WHERE o.rider_id = r.id AND o.response IS NULL AND o.expires_at > $5)`,
      [tenantId, shipmentId, since, RIDER_ACTIVE_STATUSES, now],
    );
    return rows.map((r) => ({
      riderId: r.id,
      presence: r.presence,
      maxConcurrent: r.max_concurrent,
      activeShipments: r.active,
      ratingAvg: r.rating_avg,
      codLimit: r.cod_limit,
      codBalance: r.cod_balance,
      position: { lat: r.lat, lng: r.lng, recordedAt: r.recorded_at },
    }));
  }

  async insertOffer(q: Queryable, o: NewOffer): Promise<OfferRecord> {
    const { rows } = await q.query<OfferRow>(
      `INSERT INTO logistics.dispatch_offers (shipment_id, rider_id, score, score_breakdown, offered_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING ${OFFER_COLUMNS}`,
      [o.shipmentId, o.riderId, o.score, JSON.stringify(o.breakdown), o.offeredAt, o.expiresAt],
    );
    return toOffer(rows[0]);
  }

  async findOffer(q: Queryable, id: string, opts: { lock?: boolean } = {}): Promise<OfferRecord | null> {
    const { rows } = await q.query<OfferRow>(`SELECT ${OFFER_COLUMNS} FROM logistics.dispatch_offers WHERE id = $1 ${opts.lock ? 'FOR UPDATE' : ''}`, [id]);
    return rows[0] ? toOffer(rows[0]) : null;
  }

  async findOpenForShipment(q: Queryable, shipmentId: string): Promise<OfferRecord | null> {
    const { rows } = await q.query<OfferRow>(
      `SELECT ${OFFER_COLUMNS} FROM logistics.dispatch_offers WHERE shipment_id = $1 AND response IS NULL ORDER BY offered_at DESC LIMIT 1`,
      [shipmentId],
    );
    return rows[0] ? toOffer(rows[0]) : null;
  }

  async respond(q: Queryable, id: string, response: OfferResponse, at: Date, rejectReason: string | null = null): Promise<void> {
    await q.query(`UPDATE logistics.dispatch_offers SET response = $2, responded_at = $3, reject_reason = $4 WHERE id = $1`, [id, response, at, rejectReason]);
  }

  async listOpenForRider(q: Queryable, riderId: string, now: Date): Promise<OfferRecord[]> {
    const { rows } = await q.query<OfferRow>(
      `SELECT ${OFFER_COLUMNS} FROM logistics.dispatch_offers
        WHERE rider_id = $1 AND response IS NULL AND expires_at > $2 ORDER BY offered_at, id`,
      [riderId, now],
    );
    return rows.map(toOffer);
  }

  async countOpenForRider(q: Queryable, riderId: string, now: Date): Promise<number> {
    const { rows } = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM logistics.dispatch_offers WHERE rider_id = $1 AND response IS NULL AND expires_at > $2`,
      [riderId, now],
    );
    return rows[0].n;
  }

  async listDue(q: Queryable, now: Date, limit: number, tenantId?: string): Promise<ClosedOffer[]> {
    const { rows } = await q.query<ClosedRow>(
      `SELECT o.id::text AS id, o.shipment_id, o.rider_id, s.tenant_id
         FROM logistics.dispatch_offers o JOIN logistics.shipments s ON s.id = o.shipment_id
        WHERE o.response IS NULL AND o.expires_at <= $1 AND ($3::uuid IS NULL OR s.tenant_id = $3)
        ORDER BY o.expires_at LIMIT $2`,
      [now, limit, tenantId ?? null],
    );
    return rows.map(toClosed);
  }

  async listUndispatched(q: Queryable, limit: number, tenantId?: string): Promise<{ tenantId: string; shipmentId: string }[]> {
    const { rows } = await q.query<{ tenant_id: string; id: string }>(
      `SELECT s.tenant_id, s.id
         FROM logistics.shipments s
        WHERE s.status = 'ready_for_pickup' AND s.carrier_type = 'rider' AND s.direction = 'outbound' AND s.rider_id IS NULL
          AND ($2::uuid IS NULL OR s.tenant_id = $2)
          AND NOT EXISTS (SELECT 1 FROM logistics.dispatch_offers o WHERE o.shipment_id = s.id AND o.response IS NULL)
        ORDER BY s.updated_at DESC LIMIT $1`,
      [limit, tenantId ?? null],
    );
    return rows.map((r) => ({ tenantId: r.tenant_id, shipmentId: r.id }));
  }

  async cancelOpenForRider(q: Queryable, riderId: string, at: Date): Promise<ClosedOffer[]> {
    const { rows } = await q.query<ClosedRow>(
      `UPDATE logistics.dispatch_offers o SET response = 'cancelled', responded_at = $2
         FROM logistics.shipments s
        WHERE s.id = o.shipment_id AND o.rider_id = $1 AND o.response IS NULL
        RETURNING o.id::text AS id, o.shipment_id, o.rider_id, s.tenant_id`,
      [riderId, at],
    );
    return rows.map(toClosed);
  }

  async cancelOpenForShipment(q: Queryable, shipmentId: string, at: Date): Promise<ClosedOffer[]> {
    const { rows } = await q.query<ClosedRow>(
      `UPDATE logistics.dispatch_offers o SET response = 'cancelled', responded_at = $2
         FROM logistics.shipments s
        WHERE s.id = o.shipment_id AND o.shipment_id = $1 AND o.response IS NULL
        RETURNING o.id::text AS id, o.shipment_id, o.rider_id, s.tenant_id`,
      [shipmentId, at],
    );
    return rows.map(toClosed);
  }
}
