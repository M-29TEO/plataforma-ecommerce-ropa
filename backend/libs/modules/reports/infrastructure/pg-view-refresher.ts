import { Injectable } from '@nestjs/common';
import { Database } from '../../../shared-kernel';
import { ViewRefresher } from '../application/ports';
import { MATERIALIZED_VIEWS } from './pg-reports.reader';

/**
 * REFRESH MATERIALIZED VIEW CONCURRENTLY: recalcula la vista en segundo plano y aplica solo las
 * diferencias, así el dashboard sigue leyendo la versión anterior mientras tanto (un REFRESH
 * normal bloquearía las lecturas). Cada vista en su propia transacción, con un advisory lock por
 * vista: si dos workers coinciden, el segundo la salta en vez de esperar. statement_timeout evita
 * que un refresco atascado retenga conexiones del pool.
 */
@Injectable()
export class PgViewRefresher extends ViewRefresher {
  constructor(private readonly db: Database) {
    super();
  }

  async refreshAll(): Promise<{ view: string; ms: number | null }[]> {
    const out: { view: string; ms: number | null }[] = [];
    for (const view of MATERIALIZED_VIEWS) {
      const ms = await this.db.withTransaction(async (tx) => {
        const lock = await tx.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [`reports.${view}`]);
        if (!lock.rows[0].ok) return null;
        await tx.query(`SET LOCAL statement_timeout = '10min'`);
        const started = Date.now();
        await tx.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY reports.${view}`);
        const elapsed = Date.now() - started;
        await tx.query(`UPDATE reports.refresh_log SET refreshed_at = now(), duration_ms = $2 WHERE view_name = $1`, [view, elapsed]);
        return elapsed;
      });
      out.push({ view, ms });
    }
    return out;
  }
}
