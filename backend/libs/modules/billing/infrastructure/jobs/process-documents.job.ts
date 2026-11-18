import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { APP_CONFIG, AppConfig, QUEUE_CONNECTION } from '../../../../shared-kernel';
import { DocumentProcessor } from '../../application/document-processor.service';

export const BILLING_QUEUE = 'billing';
export const PROCESS_DOCUMENTS = 'process-electronic-documents';

/**
 * Cada SRI_PROCESS_EVERY_MS (15 s por defecto) avanza los comprobantes con trabajo vencido: firma,
 * envío, consulta de autorización, RIDE y email. El backoff lo decide next_retry_at de cada
 * comprobante, no BullMQ: el job solo es el reloj. Concurrencia 1 por worker; varias réplicas no
 * se pisan porque claimDue usa SKIP LOCKED y un "préstamo" de next_retry_at.
 */
@Injectable()
export class ProcessDocumentsJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ProcessDocumentsJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly processor: DocumentProcessor,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const every = this.config.billing.processEveryMs;
    this.queue = new Queue(BILLING_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      PROCESS_DOCUMENTS,
      { every },
      { name: PROCESS_DOCUMENTS, opts: { removeOnComplete: 100, removeOnFail: 500 } },
    );
    this.worker = new Worker(
      BILLING_QUEUE,
      async (job) => (job.name === PROCESS_DOCUMENTS ? this.drain() : undefined),
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
    this.logger.log(`Scheduler "${PROCESS_DOCUMENTS}" registrado (cada ${every / 1000} s, SRI: ${this.config.billing.sriUrl})`);
  }

  /** Lotes de 20 hasta vaciar lo vencido (con un tope por pasada). */
  private async drain(): Promise<number> {
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const n = await this.processor.processDue();
      total += n;
      if (n < 20) break;
    }
    return total;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
