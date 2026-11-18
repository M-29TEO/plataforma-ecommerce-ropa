import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { APP_CONFIG, AppConfig, QUEUE_CONNECTION } from '../../../../shared-kernel';
import { NotificationDispatcher } from '../../application/notification-dispatcher.service';

export const NOTIFICATIONS_QUEUE = 'notifications';
export const DISPATCH_NOTIFICATIONS = 'dispatch-notifications';

/**
 * Cada NOTIFICATION_DISPATCH_EVERY_MS (5 s por defecto) envía lo que está en cola. El backoff lo
 * decide next_attempt_at de cada notificación, no BullMQ: el job solo es el reloj.
 */
@Injectable()
export class DispatchNotificationsJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DispatchNotificationsJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const every = this.config.notifications.dispatchEveryMs;
    this.queue = new Queue(NOTIFICATIONS_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      DISPATCH_NOTIFICATIONS,
      { every },
      { name: DISPATCH_NOTIFICATIONS, opts: { removeOnComplete: 50, removeOnFail: 200 } },
    );
    this.worker = new Worker(
      NOTIFICATIONS_QUEUE,
      async (job) => (job.name === DISPATCH_NOTIFICATIONS ? this.drain() : undefined),
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
    this.logger.log(`Scheduler "${DISPATCH_NOTIFICATIONS}" registrado (cada ${every / 1000} s, transporte: ${this.config.notifications.transport})`);
  }

  /** Lotes de 50 hasta vaciar lo vencido (con tope por pasada). */
  private async drain(): Promise<number> {
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const run = await this.dispatcher.dispatchDue();
      const n = run.sent + run.retried + run.failed;
      total += run.sent;
      if (n < 50) break;
    }
    return total;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
