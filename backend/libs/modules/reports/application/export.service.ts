import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../shared-kernel';
import {
  CONTENT_TYPES,
  ExportExpiredError,
  ExportFormat,
  ExportJob,
  exportErrorMessage,
  exportFilename,
  ExportNotFoundError,
  ExportNotReadyError,
  exportStorageKey,
  MAX_EXPORT_ATTEMPTS,
} from '../domain/export-job';
import { GROUP_LABELS, REPORT_TITLES, ReportKind, resolveQuery, TIME_GROUPS } from '../domain/report';
import { METRIC_COLUMNS } from '../domain/report-rows';
import { ExportJobRepository, ReportRenderer, ReportStorage } from './ports';
import { ReportInput, ReportQueryService } from './report-query.service';

export interface ExportView {
  id: string;
  report: ReportKind;
  format: ExportFormat;
  status: ExportJob['status'];
  params: ExportJob['params'];
  filename: string | null;
  sizeBytes: number | null;
  rowCount: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
}

export interface ExportFile {
  content: Buffer;
  contentType: string;
  filename: string;
}

export interface ExportRun {
  claimed: number;
  done: number;
  failed: number;
}

/**
 * Exportes Excel/PDF asíncronos. La API solo registra el pedido (la consulta queda validada y
 * congelada en params); el worker genera el archivo fuera del request, lo guarda en SeaweedFS y
 * la descarga lo lee de ahí. Así un exporte grande no ocupa un hilo de la API ni su memoria.
 */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly jobs: ExportJobRepository,
    private readonly queries: ReportQueryService,
    private readonly renderer: ReportRenderer,
    private readonly storage: ReportStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async request(
    cmd: { tenantId: string; userId: string; report: ReportKind; format: ExportFormat } & ReportInput,
    now = new Date(),
  ): Promise<ExportView> {
    const params = resolveQuery(cmd.report, { from: cmd.from, to: cmd.to, groupBy: cmd.groupBy }, now);
    const job = await this.jobs.create({ tenantId: cmd.tenantId, requestedBy: cmd.userId, report: cmd.report, format: cmd.format, params });
    return view(job);
  }

  /**
   * Cada exporte es de quien lo pidió (igual que el listado): el de otro usuario del tenant responde
   * 404, así no se descarga un reporte ajeno adivinando o reutilizando su id. El permiso de lectura
   * del reporte lo verifica además la API con el usuario actual.
   */
  async get(tenantId: string, id: string, userId: string): Promise<ExportView> {
    return view(await this.own(tenantId, id, userId));
  }

  async listMine(tenantId: string, userId: string, limit = 20): Promise<ExportView[]> {
    return (await this.jobs.listByRequester(tenantId, userId, limit)).map(view);
  }

  async download(tenantId: string, id: string, userId: string, now = new Date()): Promise<ExportFile> {
    const job = await this.own(tenantId, id, userId);
    if (job.status !== 'done') throw new ExportNotReadyError(job.status);
    if (job.expiresAt && job.expiresAt <= now) throw new ExportExpiredError();
    const file = await this.storage.get(job.storageKey!);
    if (!file) throw new ExportExpiredError();
    return { content: file.content, contentType: CONTENT_TYPES[job.format], filename: job.filename! };
  }

  private async own(tenantId: string, id: string, userId: string): Promise<ExportJob> {
    const job = await this.jobs.find(tenantId, id);
    if (!job || job.requestedBy !== userId) throw new ExportNotFoundError();
    return job;
  }

  /** Worker: genera los exportes pendientes. tenantId solo en tests (la base es compartida). */
  async processDue(now = new Date(), limit = 5, tenantId?: string): Promise<ExportRun> {
    const claimed = await this.jobs.claimDue(now, limit, tenantId);
    const run: ExportRun = { claimed: claimed.length, done: 0, failed: 0 };
    // Uno a la vez: cada exporte consulta y arma el archivo en memoria.
    for (const job of claimed) {
      try {
        await this.generate(job, now);
        run.done++;
      } catch (error) {
        run.failed++;
        const retry = job.attempts < MAX_EXPORT_ATTEMPTS;
        this.logger.warn(`Exporte ${job.id} falló (intento ${job.attempts}${retry ? ', se reintenta' : ''}): ${exportErrorMessage(error)}`);
        await this.jobs.markFailed(job.id, exportErrorMessage(error), new Date(), retry);
      }
    }
    return run;
  }

  private async generate(job: ExportJob, now: Date): Promise<void> {
    const maxRows = this.config.reports.exportMaxRows;
    const isTime = (TIME_GROUPS as readonly string[]).includes(job.params.groupBy);
    const result = await this.queries.run(job.report, job.tenantId, { ...job.params, limit: isTime ? job.params.limit : maxRows + 1 });
    const truncated = result.rows.length > maxRows;
    const rows = truncated ? result.rows.slice(0, maxRows) : result.rows;
    const content = await this.renderer.render(job.format, {
      title: REPORT_TITLES[job.report],
      subtitle: `Por ${GROUP_LABELS[job.params.groupBy].toLowerCase()} · del ${job.params.from} al ${job.params.to}`,
      generatedAt: now,
      groupHeader: GROUP_LABELS[job.params.groupBy],
      columns: METRIC_COLUMNS[job.report],
      rows,
      totals: result.totals,
      truncated,
    });
    const storageKey = exportStorageKey(job);
    await this.storage.put(storageKey, content, CONTENT_TYPES[job.format]);
    const finishedAt = new Date();
    await this.jobs.markDone(job.id, {
      storageKey,
      filename: exportFilename(job),
      sizeBytes: content.length,
      rowCount: rows.length,
      finishedAt,
      expiresAt: new Date(finishedAt.getTime() + this.config.reports.exportTtlDays * 86_400_000),
    });
  }
}

function view(j: ExportJob): ExportView {
  return {
    id: j.id,
    report: j.report,
    format: j.format,
    status: j.status,
    params: j.params,
    filename: j.filename,
    sizeBytes: j.sizeBytes,
    rowCount: j.rowCount,
    error: j.error,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
    expiresAt: j.expiresAt?.toISOString() ?? null,
  };
}
