import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { APP_CONFIG, AppConfig, QUEUE_CONNECTION } from '../../../../shared-kernel';
import { DispatchService } from '../../application/dispatch.service';

/** Cola propia (como las demás de Logística): un Worker de otra cola completaría estos jobs sin ejecutarlos. */
export const DISPATCH_QUEUE = 'logistics-dispatch';
export const SWEEP_DISPATCH_OFFERS = 'sweep-dispatch-offers';

/**
 * Despacho automático, cada DISPATCH_SWEEP_EVERY_MS (15 s): vence las ofertas sin respuesta y las
 * ofrece al siguiente motorizado; reintenta los envíos listos para retirar que quedaron sin oferta.
 * Si nadie puede recibir un envío, queda para la asignación manual del backoffice.
 */
@Injectable()
export class DispatchOffersJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DispatchOffersJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly dispatch: DispatchService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue(DISPATCH_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(
      SWEEP_DISPATCH_OFFERS,
      { every: this.config.logistics.dispatchSweepEveryMs },
      { name: SWEEP_DISPATCH_OFFERS, opts: { removeOnComplete: 20, removeOnFail: 50 } },
    );
    this.worker = new Worker(DISPATCH_QUEUE, () => this.run(), { connection: this.connection, concurrency: 1 });
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
  }

  async run(now = new Date()): Promise<void> {
    const r = await this.dispatch.sweep(now);
    if (r.expired > 0 || r.offered > 0) this.logger.log(`Despacho: ${r.expired} ofertas vencidas, ${r.offered} ofertas nuevas`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
