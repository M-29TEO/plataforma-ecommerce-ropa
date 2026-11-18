import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { QUEUE_CONNECTION } from '../../../../shared-kernel';
import { ReservationService } from '../../application/reservation.service';

export const INVENTORY_QUEUE = 'inventory';
export const RELEASE_EXPIRED_RESERVATIONS = 'release-expired-reservations';
export const RELEASE_EXPIRED_EVERY_MS = 60_000;

/**
 * Job repetible (cron nativo de BullMQ) que libera las reservas vencidas cada minuto.
 *
 * - upsertJobScheduler es idempotente: si arrancan varias réplicas del worker, sigue
 *   existiendo un único scheduler y el job se ejecuta una vez por minuto.
 * - Aunque dos ejecuciones se solaparan, claimExpired usa FOR UPDATE SKIP LOCKED y nunca
 *   libera dos veces la misma reserva.
 */
@Injectable()
export class ReleaseExpiredReservationsJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReleaseExpiredReservationsJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    private readonly reservations: ReservationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue(INVENTORY_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      RELEASE_EXPIRED_RESERVATIONS,
      { every: RELEASE_EXPIRED_EVERY_MS },
      { name: RELEASE_EXPIRED_RESERVATIONS, opts: { removeOnComplete: 100, removeOnFail: 500 } },
    );

    this.worker = new Worker(
      INVENTORY_QUEUE,
      async (job) => {
        if (job.name !== RELEASE_EXPIRED_RESERVATIONS) return undefined;
        return this.reservations.releaseExpired();
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
    this.logger.log(`Scheduler "${RELEASE_EXPIRED_RESERVATIONS}" registrado (cada ${RELEASE_EXPIRED_EVERY_MS / 1000} s)`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
