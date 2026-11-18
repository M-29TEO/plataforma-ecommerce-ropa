import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, fromCents, OutboxWriter } from '../../../shared-kernel';
import { OrdersApi } from '../../orders';
import type { OrderDeliveredPayload } from '../../orders';
import { PromotionsApi } from '../../promotions';
import { ReferralCodeNotFoundError, ReferralNotAllowedError } from '../domain/errors';
import { REFERRAL_QUALIFIED, REFERRAL_REWARDED, referralEvent } from '../domain/events';
import { canTransitionReferral, generateReferralCode, normalizeReferralCode, Referral, ReferralStatus } from '../domain/referral';
import { merchandiseCents, UNSETTLED_RETURN_STATUSES } from './loyalty.service';
import { ReferralRepository } from './ports';

export const REFERRAL_PROMOTION_NAME = 'Recompensa por referido';
const CODE_ATTEMPTS = 5;
const DAY_MS = 86_400_000;
const MATURE_BATCH = 100;

export interface ReferralSummary {
  code: string;
  rewardAmount: string;
  minOrderAmount: string;
  /** Sin datos personales de los referidos: solo estado y fechas. */
  referrals: Array<{ status: ReferralStatus; createdAt: Date; rewardedAt: Date | null }>;
  counts: Record<ReferralStatus, number>;
}

export interface ReferralMatureResult {
  rewarded: number;
  rejected: number;
  waiting: number;
  failed: number;
}

/**
 * Referidos: cada cliente tiene un código (customer_profiles.referral_code). Quien aún no compró
 * lo aplica una vez; su primer pedido entregado por encima del mínimo califica al referido, y
 * cuando ese pedido pasa el plazo de devolución sin devolverse completo, el referente recibe un
 * cupón personal de un uso (Promociones). La recompensa espera el plazo para que no se pueda
 * cobrar con una compra que después se devuelve.
 */
@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly db: Database,
    private readonly referrals: ReferralRepository,
    private readonly orders: OrdersApi,
    private readonly promotions: PromotionsApi,
    private readonly outbox: OutboxWriter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** El código del cliente (se crea la primera vez) y el estado de sus referidos. */
  async summary(tenantId: string, userId: string): Promise<ReferralSummary> {
    const code = await this.ensureCode(tenantId, userId);
    const list = await this.referrals.listByReferrer(this.db, tenantId, userId);
    const counts = { registered: 0, qualified: 0, rewarded: 0, rejected: 0 } as Record<ReferralStatus, number>;
    for (const r of list) counts[r.status]++;
    return {
      code,
      rewardAmount: fromCents(this.config.crm.referralRewardCents),
      minOrderAmount: fromCents(this.config.crm.referralMinOrderCents),
      referrals: list.map((r) => ({ status: r.status, createdAt: r.createdAt, rewardedAt: r.rewardedAt })),
      counts,
    };
  }

  private async ensureCode(tenantId: string, userId: string): Promise<string> {
    const profile = await this.referrals.findProfile(this.db, tenantId, userId);
    if (profile?.referralCode) return profile.referralCode;
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const code = generateReferralCode();
      if (await this.referrals.setReferralCode(this.db, tenantId, userId, code)) {
        // Dos peticiones simultáneas: gana la primera; se devuelve el código que quedó guardado.
        return (await this.referrals.findProfile(this.db, tenantId, userId))!.referralCode!;
      }
    }
    throw new Error('No se pudo generar un código de referido único');
  }

  /** El cliente nuevo aplica el código de quien lo invitó. Una sola vez y antes de su primera compra. */
  async apply(tenantId: string, userId: string, rawCode: string): Promise<{ status: ReferralStatus; minOrderAmount: string }> {
    const code = normalizeReferralCode(rawCode);
    if (!code) throw new ReferralCodeNotFoundError();
    const referrer = await this.referrals.findProfileByCode(this.db, tenantId, code);
    if (!referrer) throw new ReferralCodeNotFoundError();
    if (referrer.userId === userId) throw new ReferralNotAllowedError('SELF_REFERRAL');
    if (await this.referrals.findByReferee(this.db, tenantId, userId)) throw new ReferralNotAllowedError('ALREADY_REFERRED');
    if ((await this.orders.countActiveOrders(tenantId, userId)) > 0) throw new ReferralNotAllowedError('HAS_ORDERS');
    const referral: Referral = {
      id: randomUUID(),
      tenantId,
      referrerId: referrer.userId,
      refereeId: userId,
      status: 'registered',
      qualifyingOrder: null,
      rewardedAt: null,
      createdAt: new Date(),
    };
    if (!(await this.referrals.insert(this.db, referral))) throw new ReferralNotAllowedError('ALREADY_REFERRED');
    return { status: 'registered', minOrderAmount: fromCents(this.config.crm.referralMinOrderCents) };
  }

  /** OrderDelivered del referido: el primer pedido entregado que llega al mínimo lo califica. Idempotente. */
  async onOrderDelivered(tenantId: string, p: OrderDeliveredPayload): Promise<void> {
    if (!p.userId) return;
    const pendingReferral = await this.referrals.findByReferee(this.db, tenantId, p.userId);
    if (!pendingReferral || pendingReferral.status !== 'registered') return;
    const order = await this.orders.getOrder(tenantId, p.orderId);
    if (merchandiseCents(order) < this.config.crm.referralMinOrderCents) return;
    await this.db.withTransaction(async (tx) => {
      const r = await this.referrals.findByReferee(tx, tenantId, p.userId!, { forUpdate: true });
      if (!r || !canTransitionReferral(r.status, 'qualified')) return;
      r.status = 'qualified';
      r.qualifyingOrder = p.orderId;
      await this.referrals.update(tx, r);
      await this.outbox.append(tx, [referralEvent(tenantId, REFERRAL_QUALIFIED, { referralId: r.id, referrerId: r.referrerId, refereeId: r.refereeId, orderId: p.orderId })]);
    });
  }

  /**
   * Job: paga los referidos calificados cuyo pedido pasó el plazo de devolución sin devoluciones
   * abiertas; rechaza los que se devolvieron completos.
   */
  async matureQualified(now = new Date(), tenantId: string | null = null): Promise<ReferralMatureResult> {
    const result: ReferralMatureResult = { rewarded: 0, rejected: 0, waiting: 0, failed: 0 };
    const window = this.config.aftersales.returnWindowDays * DAY_MS;
    let after: string | null = null;
    for (;;) {
      const page = await this.referrals.listQualified(this.db, after, MATURE_BATCH, tenantId);
      if (page.length === 0) break;
      after = page[page.length - 1].id;
      for (const r of page) await this.matureOne(r, now, window, result);
      if (page.length < MATURE_BATCH) break;
    }
    return result;
  }

  private async matureOne(r: Referral, now: Date, window: number, result: ReferralMatureResult): Promise<void> {
      try {
        const order = await this.orders.getOrder(r.tenantId, r.qualifyingOrder!);
        if (!order.deliveredAt || order.deliveredAt.getTime() + window > now.getTime()) {
          result.waiting++;
          return;
        }
        const open = await this.orders.listReturns(r.tenantId, { orderId: order.id, statuses: UNSETTLED_RETURN_STATUSES, limit: 1, offset: 0 });
        if (open.length > 0) {
          result.waiting++;
          return;
        }
        const outcome = order.status === 'returned' ? await this.reject(r) : await this.reward(r);
        if (outcome === 'rewarded') result.rewarded++;
        else if (outcome === 'rejected') result.rejected++;
        else result.waiting++;
      } catch (e) {
        result.failed++;
        this.logger.error(`Referido ${r.id}: ${(e as Error).message}`);
      }
  }

  private async reject(r: Referral): Promise<'rejected' | 'skipped'> {
    return this.db.withTransaction(async (tx) => {
      const fresh = await this.referrals.findById(tx, r.tenantId, r.id, { forUpdate: true });
      if (!fresh || !canTransitionReferral(fresh.status, 'rejected')) return 'skipped';
      fresh.status = 'rejected';
      await this.referrals.update(tx, fresh);
      return 'rejected';
    });
  }

  /** Cupón y estado en la misma transacción: si algo falla, no queda un cupón sin referido pagado. */
  private async reward(r: Referral): Promise<'rewarded' | 'skipped'> {
    return this.db.withTransaction(async (tx) => {
      const fresh = await this.referrals.findById(tx, r.tenantId, r.id, { forUpdate: true });
      if (!fresh || !canTransitionReferral(fresh.status, 'rewarded')) return 'skipped';
      const coupon = await this.promotions.issueRewardCoupon({
        tenantId: r.tenantId,
        userId: r.referrerId,
        promotionName: REFERRAL_PROMOTION_NAME,
        amount: fromCents(this.config.crm.referralRewardCents),
        codePrefix: 'REF',
      });
      if (!coupon) {
        this.logger.warn(`Promoción "${REFERRAL_PROMOTION_NAME}" desactivada: el referido ${r.id} espera`);
        return 'skipped';
      }
      fresh.status = 'rewarded';
      fresh.rewardedAt = new Date();
      await this.referrals.update(tx, fresh);
      await this.outbox.append(tx, [
        referralEvent(r.tenantId, REFERRAL_REWARDED, {
          referralId: r.id,
          referrerId: r.referrerId,
          refereeId: r.refereeId,
          orderId: r.qualifyingOrder!,
          couponCode: coupon.code,
          rewardAmount: coupon.amount,
        }),
      ]);
      return 'rewarded';
    });
  }
}
