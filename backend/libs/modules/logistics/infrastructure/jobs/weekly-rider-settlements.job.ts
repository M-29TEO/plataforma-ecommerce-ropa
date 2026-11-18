import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { APP_CONFIG, AppConfig, QUEUE_CONNECTION } from '../../../../shared-kernel';
import { SettlementService } from '../../application/settlement.service';

/** Cola propia: un Worker de otra cola de Logística completaría este job sin ejecutarlo. */
export const SETTLEMENTS_QUEUE = 'logistics-settlements';
export const WEEKLY_RIDER_SETTLEMENTS = 'weekly-rider-settlements';
export const SETTLEMENT_TIMEZONE = 'America/Guayaquil';

/**
 * Job semanal (RIDER_SETTLEMENT_CRON, por defecto lunes 03:00 en Guayaquil): liquida la semana
 * lunes-domingo anterior de todos los motorizados en borrador. Es idempotente: si corre de nuevo
 * (reintento, dos réplicas) recalcula los mismos borradores y nunca toca uno aprobado o pagado.
 */
@Injectable()
export class WeeklyRiderSettlementsJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WeeklyRiderSettlementsJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly settlements: SettlementService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const pattern = this.config.logistics.settlementCron;
    this.queue = new Queue(SETTLEMENTS_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      WEEKLY_RIDER_SETTLEMENTS,
      { pattern, tz: SETTLEMENT_TIMEZONE },
      { name: WEEKLY_RIDER_SETTLEMENTS, opts: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: 20, removeOnFail: 50 } },
    );
    this.worker = new Worker(
      SETTLEMENTS_QUEUE,
      async (job) => {
        if (job.name !== WEEKLY_RIDER_SETTLEMENTS) return undefined;
        const r = await this.settlements.generate({ tenantId: null });
        this.logger.log(
          `Liquidaciones ${r.period.start}..${r.period.end}: ${r.created} nuevas, ${r.updated} recalculadas, ` +
            `${r.skipped} sin tocar, ${r.codLimitExceeded.length} sobre el límite de efectivo, ${r.failed.length} con error`,
        );
        return r;
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
    this.logger.log(`Scheduler "${WEEKLY_RIDER_SETTLEMENTS}" registrado (cron "${pattern}", ${SETTLEMENT_TIMEZONE})`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
