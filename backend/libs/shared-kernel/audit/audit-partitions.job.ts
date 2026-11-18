import { Inject, Injectable, Logger, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { Database } from '../database/database';
import { QUEUE_CONNECTION } from '../queue/queue.module';

/** Cola propia: un Worker de otra cola completaría estos jobs sin ejecutarlos. */
export const AUDIT_QUEUE = 'platform-audit';
export const ENSURE_AUDIT_PARTITIONS = 'ensure-audit-partitions';
const EVERY_MS = 24 * 60 * 60 * 1000;
const MONTHS_AHEAD = 3;

/**
 * platform.audit_log está particionada por mes: sin la partición del mes, todo INSERT falla.
 * Una vez al día (y al arrancar) crea las del mes actual y los 3 siguientes que falten
 * (platform.ensure_audit_log_partitions, idempotente; migración 0014).
 */
@Injectable()
export class AuditPartitionsJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AuditPartitionsJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue(AUDIT_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      ENSURE_AUDIT_PARTITIONS,
      { every: EVERY_MS, immediately: true },
      { name: ENSURE_AUDIT_PARTITIONS, opts: { removeOnComplete: 20, removeOnFail: 50 } },
    );
    this.worker = new Worker(AUDIT_QUEUE, () => this.ensure(), { connection: this.connection, concurrency: 1 });
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
  }

  /** Devuelve cuántas particiones creó. */
  async ensure(now = new Date()): Promise<number> {
    const { rows } = await this.db.query<{ created: number }>(
      `SELECT platform.ensure_audit_log_partitions($1::date, $2) AS created`,
      [now.toISOString().slice(0, 10), MONTHS_AHEAD + 1],
    );
    if (rows[0].created > 0) this.logger.log(`Particiones de audit_log creadas: ${rows[0].created}`);
    return rows[0].created;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}

/** Solo en el proceso worker. Requiere QueueModule. */
@Module({ providers: [AuditPartitionsJob] })
export class AuditWorkerModule {}
