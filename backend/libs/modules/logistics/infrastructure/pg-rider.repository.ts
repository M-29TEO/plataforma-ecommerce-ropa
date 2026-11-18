import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { RiderRecord, RiderRepository } from '../application/ports';

interface RiderRow {
  id: string;
  tenant_id: string;
  user_id: string;
  status: string;
  commission_scheme: unknown;
  cod_limit: string;
  cod_balance: string;
  rating_avg: string;
  rating_count: number;
}

const COLUMNS = 'id, tenant_id, user_id, status, commission_scheme, cod_limit, cod_balance, rating_avg, rating_count';

function toRecord(r: RiderRow): RiderRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    status: r.status,
    commissionScheme: r.commission_scheme,
    codLimit: r.cod_limit,
    codBalance: r.cod_balance,
    ratingAvg: r.rating_avg,
    ratingCount: r.rating_count,
  };
}

@Injectable()
export class PgRiderRepository extends RiderRepository {
  async findById(q: Queryable, tenantId: string, id: string): Promise<RiderRecord | null> {
    const { rows } = await q.query<RiderRow>(`SELECT ${COLUMNS} FROM logistics.riders WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByUser(q: Queryable, tenantId: string, userId: string): Promise<RiderRecord | null> {
    const { rows } = await q.query<RiderRow>(`SELECT ${COLUMNS} FROM logistics.riders WHERE tenant_id = $1 AND user_id = $2`, [
      tenantId,
      userId,
    ]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async lock(q: Queryable, id: string): Promise<RiderRecord | null> {
    const { rows } = await q.query<RiderRow>(`SELECT ${COLUMNS} FROM logistics.riders WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Promedio exacto desde logistics.ratings (no incremental: no acumula redondeos). La consulta
   * corre después de bloquear la fila del motorizado, así ve las calificaciones ya confirmadas por
   * transacciones concurrentes. Sin calificaciones vuelve al valor por defecto del modelo (5).
   */
  async recomputeRating(q: Queryable, id: string): Promise<{ ratingAvg: string; ratingCount: number }> {
    const { rows } = await q.query<{ rating_avg: string; rating_count: number }>(
      `UPDATE logistics.riders r
          SET rating_avg = COALESCE(s.avg, 5), rating_count = s.count
         FROM (SELECT round(avg(g.score), 2) AS avg, count(*)::int AS count
                 FROM logistics.ratings g
                WHERE g.rater_type = 'customer' AND g.ratee_id = (SELECT user_id FROM logistics.riders WHERE id = $1)) s
        WHERE r.id = $1
        RETURNING r.rating_avg, r.rating_count`,
      [id],
    );
    return { ratingAvg: rows[0].rating_avg, ratingCount: rows[0].rating_count };
  }

  async setCodBalance(q: Queryable, id: string, codBalance: string): Promise<void> {
    await q.query(`UPDATE logistics.riders SET cod_balance = $2 WHERE id = $1`, [id, codBalance]);
  }
}
