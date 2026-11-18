import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { APP_CONFIG, AppConfig, QUEUE_CONNECTION } from '../../../../shared-kernel';
import { SlaMonitorService } from '../../application/sla-monitor.service';

export const SUPPORT_QUEUE = 'support';
export const SWEEP_SUPPORT_TICKETS = 'sweep-support-tickets';

/**
 * Cada SUPPORT_SWEEP_EVERY_MS (5 min por defecto) alerta los SLA vencidos y cierra los tickets
 * resueltos sin respuesta. El job solo es el reloj: lo pendiente lo deciden las columnas del ticket.
 */
@Injectable()
export class SupportSlaJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SupportSlaJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly monitor: SlaMonitorService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const every = this.config.support.sweepEveryMs;
    this.queue = new Queue(SUPPORT_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      SWEEP_SUPPORT_TICKETS,
      { every },
      { name: SWEEP_SUPPORT_TICKETS, opts: { removeOnComplete: 50, removeOnFail: 200 } },
    );
    this.worker = new Worker(
      SUPPORT_QUEUE,
      async (job) => (job.name === SWEEP_SUPPORT_TICKETS ? this.drain() : undefined),
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
    this.logger.log(`Scheduler "${SWEEP_SUPPORT_TICKETS}" registrado (cada ${every / 1000} s)`);
  }

  /** Lotes de 50 hasta vaciar (con tope por pasada). */
  private async drain(): Promise<{ breached: number; autoClosed: number }> {
    const total = { breached: 0, autoClosed: 0 };
    for (let i = 0; i < 20; i++) {
      const run = await this.monitor.sweep();
      total.breached += run.breached;
      total.autoClosed += run.autoClosed;
      if (!run.more) break;
    }
    return total;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
