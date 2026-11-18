import { ObjectStorage } from '../../../shared-kernel';
import { ExportFormat, ExportJob } from '../domain/export-job';
import { DateRange, ReportKind } from '../domain/report';
import { RawAggregate, ReportColumn, ReportMetrics, ReportRow } from '../domain/report-rows';

export interface AggregateRow {
  key: string;
  label: string;
  raw: RawAggregate;
}

/** Lectura de las vistas materializadas del schema reports (siempre filtrada por tenant). */
export abstract class ReportsReader {
  /** Filas agrupadas por groupBy (dimensión validada en el dominio), con tope de filas. */
  abstract grouped(kind: ReportKind, tenantId: string, range: DateRange, groupBy: string, limit: number): Promise<AggregateRow[]>;
  abstract totals(kind: ReportKind, tenantId: string, range: DateRange): Promise<RawAggregate>;
  /** Último refresco de la vista que alimenta el reporte. */
  abstract dataAsOf(kind: ReportKind): Promise<Date | null>;
}

/** Refresco de las vistas materializadas (worker). */
export abstract class ViewRefresher {
  /** Refresca cada vista; ms = null si otro proceso la estaba refrescando (lock tomado) y se saltó. */
  abstract refreshAll(): Promise<{ view: string; ms: number | null }[]>;
}

export interface NewExportJob {
  tenantId: string;
  requestedBy: string;
  report: ReportKind;
  format: ExportFormat;
  params: ExportJob['params'];
}

export abstract class ExportJobRepository {
  abstract create(job: NewExportJob): Promise<ExportJob>;
  abstract find(tenantId: string, id: string): Promise<ExportJob | null>;
  abstract listByRequester(tenantId: string, requestedBy: string, limit: number): Promise<ExportJob[]>;
  /** Toma hasta `limit` jobs pendientes (o 'running' abandonados) con SKIP LOCKED y los pasa a 'running'. */
  abstract claimDue(now: Date, limit: number, tenantId?: string): Promise<ExportJob[]>;
  abstract markDone(
    id: string,
    result: { storageKey: string; filename: string; sizeBytes: number; rowCount: number; finishedAt: Date; expiresAt: Date },
  ): Promise<void>;
  /** Vuelve a 'queued' si quedan intentos; si no, 'failed'. */
  abstract markFailed(id: string, error: string, finishedAt: Date, retry: boolean): Promise<void>;
}

/** Token de inyección de Reportes para el ObjectStorage compartido (claves reports/...). */
export abstract class ReportStorage extends ObjectStorage {}

export interface ReportDocument {
  title: string;
  subtitle: string;
  generatedAt: Date;
  groupHeader: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportMetrics;
  /** true si se cortó en exportMaxRows. */
  truncated: boolean;
}

/** Genera el archivo (Excel con ExcelJS o PDF con pdfkit). */
export abstract class ReportRenderer {
  abstract render(format: ExportFormat, doc: ReportDocument): Promise<Buffer>;
}
