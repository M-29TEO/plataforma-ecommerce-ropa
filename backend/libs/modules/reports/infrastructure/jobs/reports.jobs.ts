import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { APP_CONFIG, AppConfig, QUEUE_CONNECTION } from '../../../../shared-kernel';
import { ExportService } from '../../application/export.service';
import { ViewRefresher } from '../../application/ports';

export const REPORTS_QUEUE = 'reports';
export const REFRESH_REPORT_VIEWS = 'refresh-report-views';
export const PROCESS_REPORT_EXPORTS = 'process-report-exports';

/**
 * Proceso worker, cola "reports":
 *  - refresh-report-views cada REPORTS_REFRESH_EVERY_MS (15 min): REFRESH ... CONCURRENTLY de las vistas.
 *  - process-report-exports cada REPORTS_EXPORT_EVERY_MS (5 s): genera los exportes pendientes.
 * Concurrencia 1: un refresco y un exporte nunca compiten entre sí por la base en este worker, y
 * los locks (advisory / SKIP LOCKED) cubren el caso de varios workers.
 */
@Injectable()
export class ReportsJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReportsJobs.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly refresher: ViewRefresher,
    private readonly exports: ExportService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { refreshEveryMs, exportEveryMs } = this.config.reports;
    this.queue = new Queue(REPORTS_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      REFRESH_REPORT_VIEWS,
      { every: refreshEveryMs },
      { name: REFRESH_REPORT_VIEWS, opts: { removeOnComplete: 50, removeOnFail: 200 } },
    );
    await this.queue.upsertJobScheduler(
      PROCESS_REPORT_EXPORTS,
      { every: exportEveryMs },
      { name: PROCESS_REPORT_EXPORTS, opts: { removeOnComplete: 50, removeOnFail: 200 } },
    );
    this.worker = new Worker(
      REPORTS_QUEUE,
      async (job) => {
        if (job.name === REFRESH_REPORT_VIEWS) return this.refresh();
        if (job.name === PROCESS_REPORT_EXPORTS) return this.exports.processDue();
        return undefined;
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
    this.logger.log(
      `Schedulers "${REFRESH_REPORT_VIEWS}" (cada ${refreshEveryMs / 1000} s) y "${PROCESS_REPORT_EXPORTS}" (cada ${exportEveryMs / 1000} s) registrados`,
    );
  }

  private async refresh() {
    const result = await this.refresher.refreshAll();
    this.logger.log(`Vistas de reportes: ${result.map((r) => `${r.view} ${r.ms === null ? 'saltada (lock)' : `${r.ms} ms`}`).join(', ')}`);
    return result;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
