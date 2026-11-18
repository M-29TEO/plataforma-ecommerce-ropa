import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { QUEUE_CONNECTION } from '../queue/queue.module';
import { OutboxRelay } from './outbox-relay';

export const PLATFORM_QUEUE = 'platform';
export const PUBLISH_OUTBOX = 'publish-outbox';
export const PUBLISH_OUTBOX_EVERY_MS = 2_000;

/**
 * Publica el outbox cada 2 s con un job scheduler de BullMQ (uno solo aunque haya varias
 * réplicas). concurrency 1 por réplica; entre réplicas, SKIP LOCKED evita el doble proceso.
 */
@Injectable()
export class OutboxRelayJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    private readonly relay: OutboxRelay,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue(PLATFORM_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      PUBLISH_OUTBOX,
      { every: PUBLISH_OUTBOX_EVERY_MS },
      { name: PUBLISH_OUTBOX, opts: { removeOnComplete: 50, removeOnFail: 200 } },
    );
    this.worker = new Worker(
      PLATFORM_QUEUE,
      async (job) => (job.name === PUBLISH_OUTBOX ? this.relay.drain() : undefined),
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
    this.logger.log(`Relay del outbox registrado (cada ${PUBLISH_OUTBOX_EVERY_MS / 1000} s)`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
