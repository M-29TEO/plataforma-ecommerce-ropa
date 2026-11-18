import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { Database, QUEUE_CONNECTION } from '../../../../shared-kernel';

/** Cola propia: el Worker de la cola 'logistics' completaría estos jobs sin ejecutarlos. */
export const RIDER_PARTITIONS_QUEUE = 'logistics-partitions';
export const ENSURE_RIDER_PARTITIONS = 'ensure-rider-location-partitions';
const EVERY_MS = 24 * 60 * 60 * 1000;
const MONTHS_AHEAD = 3;

/**
 * logistics.rider_location_history está particionada por mes: sin la partición del mes, toda
 * posición del motorizado falla. Una vez al día (y al arrancar) crea las del mes actual y los 3
 * siguientes que falten (logistics.ensure_rider_location_partitions, idempotente; migración 0016).
 */
@Injectable()
export class RiderLocationPartitionsJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RiderLocationPartitionsJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue(RIDER_PARTITIONS_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      ENSURE_RIDER_PARTITIONS,
      { every: EVERY_MS, immediately: true },
      { name: ENSURE_RIDER_PARTITIONS, opts: { removeOnComplete: 20, removeOnFail: 50 } },
    );
    this.worker = new Worker(RIDER_PARTITIONS_QUEUE, () => this.ensure(), { connection: this.connection, concurrency: 1 });
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
  }

  /** Devuelve cuántas particiones creó. */
  async ensure(now = new Date()): Promise<number> {
    const { rows } = await this.db.query<{ created: number }>(
      `SELECT logistics.ensure_rider_location_partitions($1::date, $2) AS created`,
      [now.toISOString().slice(0, 10), MONTHS_AHEAD + 1],
    );
    if (rows[0].created > 0) this.logger.log(`Particiones de rider_location_history creadas: ${rows[0].created}`);
    return rows[0].created;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
