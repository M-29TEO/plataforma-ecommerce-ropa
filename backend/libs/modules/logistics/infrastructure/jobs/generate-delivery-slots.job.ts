import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { QUEUE_CONNECTION } from '../../../../shared-kernel';
import { SlotService } from '../../application/slot.service';

export const LOGISTICS_QUEUE = 'logistics';
export const GENERATE_DELIVERY_SLOTS = 'generate-delivery-slots';
/** Cada hora (y al arrancar): mantiene siempre DELIVERY_SLOT_DAYS_AHEAD días de franjas. */
export const GENERATE_SLOTS_EVERY_MS = 60 * 60 * 1000;

/**
 * Job repetible que genera las franjas desde las plantillas. Es idempotente (ON CONFLICT
 * (zone_id, starts_at) DO NOTHING): correrlo de más, o en varias réplicas, no duplica franjas ni
 * pisa el cupo reservado.
 */
@Injectable()
export class GenerateDeliverySlotsJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(GenerateDeliverySlotsJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    private readonly slots: SlotService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue(LOGISTICS_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      GENERATE_DELIVERY_SLOTS,
      { every: GENERATE_SLOTS_EVERY_MS, immediately: true },
      { name: GENERATE_DELIVERY_SLOTS, opts: { removeOnComplete: 50, removeOnFail: 200 } },
    );
    this.worker = new Worker(
      LOGISTICS_QUEUE,
      async (job) => (job.name === GENERATE_DELIVERY_SLOTS ? this.slots.generateAll() : undefined),
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
    this.logger.log(`Scheduler "${GENERATE_DELIVERY_SLOTS}" registrado (cada ${GENERATE_SLOTS_EVERY_MS / 60_000} min)`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
