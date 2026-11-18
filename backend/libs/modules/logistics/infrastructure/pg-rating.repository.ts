import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { NewRating, RateableShipment, RatingRecord, RatingRepository } from '../application/ports';
import { RaterType } from '../domain/rating';

interface RatingRow {
  id: string;
  shipment_id: string;
  rater_type: RaterType;
  rater_id: string;
  ratee_id: string;
  score: number;
  tags: string[];
  comment: string | null;
  created_at: Date;
}

const COLUMNS = 'id, shipment_id, rater_type, rater_id, ratee_id, score, tags, comment, created_at';

function toRecord(r: RatingRow): RatingRecord {
  return {
    id: r.id,
    shipmentId: r.shipment_id,
    raterType: r.rater_type,
    raterId: r.rater_id,
    rateeId: r.ratee_id,
    score: r.score,
    tags: r.tags,
    comment: r.comment,
    createdAt: r.created_at,
  };
}

@Injectable()
export class PgRatingRepository extends RatingRepository {
  async findShipment(q: Queryable, tenantId: string, shipmentId: string): Promise<RateableShipment | null> {
    const { rows } = await q.query<{
      id: string;
      order_id: string;
      carrier_type: string;
      status: string;
      rider_id: string | null;
      rider_user_id: string | null;
      delivered_at: Date | null;
    }>(
      `SELECT s.id, s.order_id, s.carrier_type, s.status, s.rider_id, r.user_id AS rider_user_id, s.delivered_at
         FROM logistics.shipments s LEFT JOIN logistics.riders r ON r.id = s.rider_id
        WHERE s.tenant_id = $1 AND s.id = $2`,
      [tenantId, shipmentId],
    );
    const r = rows[0];
    return r
      ? {
          id: r.id,
          orderId: r.order_id,
          carrierType: r.carrier_type,
          status: r.status,
          riderId: r.rider_id,
          riderUserId: r.rider_user_id,
          deliveredAt: r.delivered_at,
        }
      : null;
  }

  async insert(q: Queryable, r: NewRating): Promise<RatingRecord | null> {
    const { rows } = await q.query<RatingRow>(
      `INSERT INTO logistics.ratings (shipment_id, rater_type, rater_id, ratee_id, score, tags, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (shipment_id, rater_type) DO NOTHING
       RETURNING ${COLUMNS}`,
      [r.shipmentId, r.raterType, r.raterId, r.rateeId, r.score, r.tags, r.comment],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(q: Queryable, raterType: RaterType, rateeId: string, limit: number): Promise<RatingRecord[]> {
    const { rows } = await q.query<RatingRow>(
      `SELECT ${COLUMNS} FROM logistics.ratings WHERE rater_type = $1 AND ratee_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [raterType, rateeId, limit],
    );
    return rows.map(toRecord);
  }

  async summary(q: Queryable, raterType: RaterType, rateeId: string): Promise<{ ratingAvg: string | null; ratingCount: number }> {
    const { rows } = await q.query<{ avg: string | null; count: number }>(
      `SELECT round(avg(score), 2)::text AS avg, count(*)::int AS count FROM logistics.ratings WHERE rater_type = $1 AND ratee_id = $2`,
      [raterType, rateeId],
    );
    return { ratingAvg: rows[0].avg, ratingCount: rows[0].count };
  }
}
