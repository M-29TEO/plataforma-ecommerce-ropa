import { ConflictError, NotFoundError } from '../../../shared-kernel';
import { ReportKind, ReportQuery } from './report';

/**
 * Exporte asíncrono: la API lo deja en 'queued', el worker lo toma ('running'), genera el archivo,
 * lo guarda en SeaweedFS y lo marca 'done' (o 'failed' tras MAX_EXPORT_ATTEMPTS). Un 'running'
 * que lleva más de STALE_RUNNING_MS sin terminar (worker caído) se vuelve a tomar.
 */
export const EXPORT_FORMATS = ['xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type ExportStatus = 'queued' | 'running' | 'done' | 'failed';

export const MAX_EXPORT_ATTEMPTS = 3;
export const STALE_RUNNING_MS = 10 * 60_000;

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export interface ExportJob {
  id: string;
  tenantId: string;
  requestedBy: string;
  report: ReportKind;
  format: ExportFormat;
  params: ReportQuery;
  status: ExportStatus;
  attempts: number;
  storageKey: string | null;
  filename: string | null;
  sizeBytes: number | null;
  rowCount: number | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  expiresAt: Date | null;
}

export class ExportNotFoundError extends NotFoundError {
  constructor() {
    super('EXPORT_NOT_FOUND', 'Exporte no encontrado');
  }
}

export class ExportNotReadyError extends ConflictError {
  constructor(status: ExportStatus) {
    super('EXPORT_NOT_READY', status === 'failed' ? 'El exporte falló; solicítalo de nuevo' : 'El exporte aún se está generando', {
      status,
    });
  }
}

export class ExportExpiredError extends ConflictError {
  constructor() {
    super('EXPORT_EXPIRED', 'El archivo del exporte venció; solicítalo de nuevo');
  }
}

/** Clave en SeaweedFS (prefijo del módulo, por tenant). */
export function exportStorageKey(job: Pick<ExportJob, 'tenantId' | 'id' | 'format'>): string {
  return `reports/exports/${job.tenantId}/${job.id}.${job.format}`;
}

/** reporte-ventas-dia-2026-09-01-a-2026-09-30.xlsx */
export function exportFilename(job: Pick<ExportJob, 'report' | 'format' | 'params'>): string {
  const report = job.report.replace(/_/g, '-');
  const group = job.params.groupBy.replace(/_/g, '-');
  return `reporte-${report}-${group}-${job.params.from}-a-${job.params.to}.${job.format}`;
}

/** Mensaje de error guardado en el job: una línea, sin pilas ni datos sensibles, con tope de largo. */
export function exportErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].slice(0, 500);
}
