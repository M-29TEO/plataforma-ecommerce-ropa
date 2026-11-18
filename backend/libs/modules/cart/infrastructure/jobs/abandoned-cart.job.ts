import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { APP_CONFIG, AppConfig, QUEUE_CONNECTION } from '../../../../shared-kernel';
import { AbandonedCartService } from '../../application/abandoned-cart.service';

export const CART_QUEUE = 'cart';
export const REMIND_ABANDONED_CARTS = 'remind-abandoned-carts';

/**
 * Cada CART_REMINDER_EVERY_MS (5 min por defecto) emite los recordatorios vencidos de carrito
 * abandonado. El job solo es el reloj: la etapa la decide reminders_sent de cada carrito.
 */
@Injectable()
export class AbandonedCartJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AbandonedCartJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly service: AbandonedCartService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const every = this.config.cartReminderEveryMs;
    this.queue = new Queue(CART_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      REMIND_ABANDONED_CARTS,
      { every },
      { name: REMIND_ABANDONED_CARTS, opts: { removeOnComplete: 50, removeOnFail: 200 } },
    );
    this.worker = new Worker(
      CART_QUEUE,
      async (job) => (job.name === REMIND_ABANDONED_CARTS ? this.drain() : undefined),
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
    this.logger.log(`Scheduler "${REMIND_ABANDONED_CARTS}" registrado (cada ${every / 1000} s)`);
  }

  /** Lotes de 50 hasta que no queden candidatos (con tope por pasada). */
  private async drain(): Promise<number> {
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const run = await this.service.processDue();
      total += run.reminded;
      if (run.scanned < 50) break;
    }
    return total;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
