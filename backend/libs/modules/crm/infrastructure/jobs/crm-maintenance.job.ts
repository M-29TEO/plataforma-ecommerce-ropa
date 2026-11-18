import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { APP_CONFIG, AppConfig, QUEUE_CONNECTION } from '../../../../shared-kernel';
import { LoyaltyService } from '../../application/loyalty.service';
import { ReferralService } from '../../application/referral.service';
import { WishlistService } from '../../application/wishlist.service';

/** Cola propia: un Worker de otra cola completaría estos jobs sin ejecutarlos. */
export const CRM_QUEUE = 'crm';
export const MATURE_LOYALTY = 'mature-loyalty-points';
export const SCAN_WISHLISTS = 'scan-wishlists';

/**
 * Relojes del CRM:
 *  - MATURE_LOYALTY (LOYALTY_MATURE_EVERY_MS, 1 h): acredita los puntos que pasaron el plazo de
 *    devolución y paga los referidos calificados.
 *  - SCAN_WISHLISTS (WISHLIST_SCAN_EVERY_MS, 30 min): alertas de reposición y bajada de precio.
 * Ambos son idempotentes: dos réplicas o un reintento no duplican puntos, cupones ni avisos.
 */
@Injectable()
export class CrmMaintenanceJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CrmMaintenanceJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: ConnectionOptions,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly loyalty: LoyaltyService,
    private readonly referrals: ReferralService,
    private readonly wishlist: WishlistService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const opts = { removeOnComplete: 50, removeOnFail: 200 };
    this.queue = new Queue(CRM_QUEUE, { connection: this.connection });
    await this.queue.upsertJobScheduler(MATURE_LOYALTY, { every: this.config.crm.loyaltyMatureEveryMs }, { name: MATURE_LOYALTY, opts });
    await this.queue.upsertJobScheduler(SCAN_WISHLISTS, { every: this.config.crm.wishlistScanEveryMs }, { name: SCAN_WISHLISTS, opts });
    this.worker = new Worker(CRM_QUEUE, async (job) => this.run(job.name), { connection: this.connection, concurrency: 1 });
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name} falló: ${err.message}`, err.stack));
    this.logger.log(
      `Schedulers "${MATURE_LOYALTY}" (cada ${this.config.crm.loyaltyMatureEveryMs / 1000} s) y ` +
        `"${SCAN_WISHLISTS}" (cada ${this.config.crm.wishlistScanEveryMs / 1000} s) registrados`,
    );
  }

  private async run(name: string): Promise<unknown> {
    if (name === MATURE_LOYALTY) {
      const points = await this.loyalty.matureDue();
      const referrals = await this.referrals.matureQualified();
      if (points.posted || points.postponed || referrals.rewarded || referrals.rejected) {
        this.logger.log(
          `Puntos: ${points.posted} pedidos acreditados, ${points.postponed} pospuestos; ` +
            `referidos: ${referrals.rewarded} recompensados, ${referrals.rejected} rechazados`,
        );
      }
      return { points, referrals };
    }
    if (name === SCAN_WISHLISTS) {
      const r = await this.wishlist.scan();
      if (r.backInStock || r.priceDrops) this.logger.log(`Wishlist: ${r.backInStock} reposiciones y ${r.priceDrops} bajadas de precio avisadas`);
      return r;
    }
    return undefined;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
