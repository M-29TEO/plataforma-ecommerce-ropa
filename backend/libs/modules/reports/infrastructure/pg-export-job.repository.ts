import { Injectable } from '@nestjs/common';
import { Database } from '../../../shared-kernel';
import { ExportJobRepository, NewExportJob } from '../application/ports';
import { ExportJob, MAX_EXPORT_ATTEMPTS, STALE_RUNNING_MS } from '../domain/export-job';

const COLUMNS = `id, tenant_id, requested_by, report, format, params, status, attempts, storage_key, filename, size_bytes,
  row_count, error, created_at, started_at, finished_at, expires_at`;

interface Row {
  id: string;
  tenant_id: string;
  requested_by: string;
  report: ExportJob['report'];
  format: ExportJob['format'];
  params: ExportJob['params'];
  status: ExportJob['status'];
  attempts: number;
  storage_key: string | null;
  filename: string | null;
  size_bytes: number | null;
  row_count: number | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  expires_at: Date | null;
}

function toJob(r: Row): ExportJob {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    requestedBy: r.requested_by,
    report: r.report,
    format: r.format,
    params: r.params,
    status: r.status,
    attempts: r.attempts,
    storageKey: r.storage_key,
    filename: r.filename,
    sizeBytes: r.size_bytes,
    rowCount: r.row_count,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    expiresAt: r.expires_at,
  };
}

@Injectable()
export class PgExportJobRepository extends ExportJobRepository {
  constructor(private readonly db: Database) {
    super();
  }

  async create(j: NewExportJob): Promise<ExportJob> {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO reports.export_jobs (tenant_id, requested_by, report, format, params)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
      [j.tenantId, j.requestedBy, j.report, j.format, JSON.stringify(j.params)],
    );
    return toJob(rows[0]);
  }

  async find(tenantId: string, id: string): Promise<ExportJob | null> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM reports.export_jobs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async listByRequester(tenantId: string, requestedBy: string, limit: number): Promise<ExportJob[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM reports.export_jobs WHERE tenant_id = $1 AND requested_by = $2 ORDER BY created_at DESC LIMIT $3`,
      [tenantId, requestedBy, limit],
    );
    return rows.map(toJob);
  }

  /** Pendientes por antigüedad; un 'running' sin terminar tras STALE_RUNNING_MS se retoma. */
  async claimDue(now: Date, limit: number, tenantId?: string): Promise<ExportJob[]> {
    const { rows } = await this.db.query<Row>(
      `UPDATE reports.export_jobs j
          SET status = 'running', attempts = j.attempts + 1, started_at = $1, error = NULL
        WHERE j.id IN (
          SELECT id FROM reports.export_jobs
           WHERE (status = 'queued' OR (status = 'running' AND started_at < $2 AND attempts < $5))
             AND ($4::uuid IS NULL OR tenant_id = $4)
           ORDER BY created_at
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING ${COLUMNS}`,
      [now, new Date(now.getTime() - STALE_RUNNING_MS), limit, tenantId ?? null, MAX_EXPORT_ATTEMPTS],
    );
    return rows.map(toJob);
  }

  async markDone(
    id: string,
    r: { storageKey: string; filename: string; sizeBytes: number; rowCount: number; finishedAt: Date; expiresAt: Date },
  ): Promise<void> {
    await this.db.query(
      `UPDATE reports.export_jobs
          SET status = 'done', storage_key = $2, filename = $3, size_bytes = $4, row_count = $5, finished_at = $6, expires_at = $7, error = NULL
        WHERE id = $1`,
      [id, r.storageKey, r.filename, r.sizeBytes, r.rowCount, r.finishedAt, r.expiresAt],
    );
  }

  async markFailed(id: string, error: string, finishedAt: Date, retry: boolean): Promise<void> {
    await this.db.query(
      `UPDATE reports.export_jobs SET status = $2, error = $3, finished_at = CASE WHEN $2 = 'failed' THEN $4::timestamptz END WHERE id = $1`,
      [id, retry ? 'queued' : 'failed', error, finishedAt],
    );
  }
}
