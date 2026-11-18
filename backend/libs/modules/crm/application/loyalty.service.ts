import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, fromCents, isUniqueViolation, OutboxWriter, Queryable, toCents } from '../../../shared-kernel';
import { OrderNotFoundError, OrdersApi } from '../../orders';
import type { OrderDeliveredPayload, OrderProps, ReturnEventPayload, ReturnStatus } from '../../orders';
import { PromotionsApi } from '../../promotions';
import {
  InsufficientPointsError,
  InvalidAdjustmentError,
  InvalidRedemptionError,
  TierConflictError,
  TierInUseError,
  TierNotFoundError,
} from '../domain/errors';
import {
  LOYALTY_POINTS_EARNED,
  LOYALTY_POINTS_POSTED,
  LOYALTY_POINTS_REDEEMED,
  LOYALTY_TIER_CHANGED,
  LoyaltyPointsEarnedPayload,
  LoyaltyPointsPostedPayload,
  LoyaltyPointsRedeemedPayload,
  LoyaltyTierChangedPayload,
  loyaltyEvent,
} from '../domain/events';
import {
  earnPoints,
  LoyaltyAccount,
  LoyaltyTier,
  LoyaltyTransaction,
  nextTier,
  promotedTier,
  redemptionValueCents,
  resolveTier,
  reversalPoints,
  TierInput,
  validateTier,
} from '../domain/loyalty';
import { LoyaltyRepository } from './ports';

/** Una devolución en estos estados todavía puede terminar en reembolso: los puntos esperan. */
export const UNSETTLED_RETURN_STATUSES: ReturnStatus[] = ['requested', 'approved', 'pickup_scheduled', 'received', 'inspected'];

const DAY_MS = 86_400_000;
const MATURE_BATCH = 100;

export type TierView = Omit<LoyaltyTier, 'tenantId'>;

export interface LoyaltyAccountView {
  tier: TierView | null;
  nextTier: (TierView & { pointsToGo: number }) | null;
  pointsBalance: number;
  pointsPending: number;
  lifetimePoints: number;
  /** Puntos en espera por pedido y cuándo se acreditan (si no hay devoluciones abiertas). */
  pending: Array<{ orderId: string | null; points: number; availableAt: Date | null }>;
  redemption: { pointsPerUsd: number; minPoints: number; maxAmount: string };
}

export interface MatureResult {
  posted: number;
  postponed: number;
  failed: number;
}

/** Valor de la mercadería del pedido (IVA incluido, sin envío): la base de los puntos. */
export function merchandiseCents(o: Pick<OrderProps, 'total' | 'giftCardTotal' | 'shippingTotal'>): number {
  return Math.max(0, toCents(o.total) + toCents(o.giftCardTotal) - toCents(o.shippingTotal));
}

function tierView(t: LoyaltyTier): TierView {
  const { tenantId: _t, ...rest } = t;
  return rest;
}

/**
 * Programa de puntos:
 *  - OrderDelivered → acumulación PENDIENTE (puntos × multiplicador del nivel) que se acredita al
 *    pasar el plazo de devolución, y solo si el pedido no tiene devoluciones abiertas.
 *  - ReturnRefunded → reversa proporcional a lo reembolsado (pendiente si la acumulación lo está).
 *  - El nivel se calcula con los puntos históricos acreditados y no baja.
 * Cada movimiento se escribe con la cuenta bloqueada (FOR UPDATE) y su saldo en la misma
 * transacción; el índice único de reference hace idempotentes los consumidores.
 */
@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private readonly db: Database,
    private readonly loyalty: LoyaltyRepository,
    private readonly orders: OrdersApi,
    private readonly promotions: PromotionsApi,
    private readonly outbox: OutboxWriter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ niveles (backoffice)

  async listTiers(tenantId: string): Promise<TierView[]> {
    return (await this.loyalty.listTiers(this.db, tenantId)).map(tierView);
  }

  async createTier(tenantId: string, input: TierInput): Promise<TierView> {
    const v = validateTier(input) as Required<ReturnType<typeof validateTier>>;
    const tier: LoyaltyTier = { id: randomUUID(), tenantId, ...v };
    await this.guardTierConflict(() => this.loyalty.insertTier(this.db, tier));
    return tierView(tier);
  }

  async updateTier(tenantId: string, id: string, input: TierInput): Promise<TierView> {
    const current = await this.loyalty.findTier(this.db, tenantId, id);
    if (!current) throw new TierNotFoundError(id);
    const updated: LoyaltyTier = { ...current, ...validateTier(input, true) };
    await this.guardTierConflict(() => this.loyalty.updateTier(this.db, updated));
    return tierView(updated);
  }

  /** Un nivel con clientes no se borra (pierden la referencia): primero se edita o se crea otro. */
  async deleteTier(tenantId: string, id: string): Promise<void> {
    const current = await this.loyalty.findTier(this.db, tenantId, id);
    if (!current) throw new TierNotFoundError(id);
    const inUse = await this.loyalty.countAccountsInTier(this.db, id);
    if (inUse > 0) throw new TierInUseError(inUse);
    await this.loyalty.deleteTier(this.db, tenantId, id);
  }

  private async guardTierConflict(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (isUniqueViolation(e, 'ux_tiers_name')) throw new TierConflictError('name');
      if (isUniqueViolation(e)) throw new TierConflictError('minPoints');
      throw e;
    }
  }

  // ------------------------------------------------------------------ cliente

  async account(tenantId: string, userId: string): Promise<LoyaltyAccountView> {
    const [tiers, account] = await Promise.all([this.loyalty.listTiers(this.db, tenantId), this.loyalty.findAccount(this.db, tenantId, userId)]);
    const lifetime = account?.lifetimePoints ?? 0;
    const tier = tiers.find((t) => t.id === account?.tierId) ?? resolveTier(tiers, lifetime);
    const next = nextTier(tiers, Math.max(lifetime, tier?.minPoints ?? 0));
    const pending = account ? await this.loyalty.listPending(this.db, tenantId, userId) : [];
    const byOrder = new Map<string, { orderId: string | null; points: number; availableAt: Date | null }>();
    for (const tx of pending) {
      const key = tx.orderId ?? tx.id;
      const entry = byOrder.get(key) ?? { orderId: tx.orderId, points: 0, availableAt: tx.availableAt };
      entry.points += tx.points;
      byOrder.set(key, entry);
    }
    const balance = account?.pointsBalance ?? 0;
    const { redeemPointsPerUsd, redeemMinPoints } = this.config.crm;
    const redeemable = balance - (balance % redeemPointsPerUsd);
    return {
      tier: tier ? tierView(tier) : null,
      nextTier: next ? { ...tierView(next), pointsToGo: next.minPoints - lifetime } : null,
      pointsBalance: balance,
      pointsPending: account?.pointsPending ?? 0,
      lifetimePoints: lifetime,
      pending: [...byOrder.values()].filter((p) => p.points !== 0),
      redemption: {
        pointsPerUsd: redeemPointsPerUsd,
        minPoints: redeemMinPoints,
        maxAmount: fromCents(redeemable >= redeemMinPoints ? redemptionValueCents(redeemable, { pointsPerUsd: redeemPointsPerUsd, minPoints: redeemMinPoints }) : 0),
      },
    };
  }

  history(tenantId: string, userId: string, limit: number, offset: number): Promise<LoyaltyTransaction[]> {
    return this.loyalty.listTransactions(this.db, tenantId, userId, limit, offset);
  }

  /**
   * Canje por saldo a favor: gift card nueva por el valor de los puntos (bloques de
   * redeemPointsPerUsd). El código se devuelve UNA sola vez, en esta respuesta.
   */
  async redeem(tenantId: string, userId: string, points: number) {
    const { redeemPointsPerUsd, redeemMinPoints } = this.config.crm;
    if (!Number.isInteger(points) || points < redeemMinPoints) {
      throw new InvalidRedemptionError('REDEMPTION_BELOW_MINIMUM', `El canje mínimo es de ${redeemMinPoints} puntos`, { minPoints: redeemMinPoints });
    }
    if (points % redeemPointsPerUsd !== 0) {
      throw new InvalidRedemptionError('REDEMPTION_NOT_MULTIPLE', `Los puntos se canjean en bloques de ${redeemPointsPerUsd} (1 USD)`, {
        pointsPerUsd: redeemPointsPerUsd,
      });
    }
    const amount = fromCents(redemptionValueCents(points, { pointsPerUsd: redeemPointsPerUsd, minPoints: redeemMinPoints }));
    return this.db.withTransaction(async (tx) => {
      const account = await this.loyalty.findAccount(tx, tenantId, userId, { forUpdate: true });
      const balance = account?.pointsBalance ?? 0;
      if (!account || balance < points) throw new InsufficientPointsError(balance, points);
      const card = await this.promotions.issueGiftCard({ tenantId, amount, recipientEmail: null, purchaserId: userId });
      await this.loyalty.insertTransaction(tx, {
        userId,
        tenantId,
        type: 'redeem',
        points: -points,
        orderId: null,
        reference: card.giftCardId,
        status: 'posted',
        availableAt: null,
        expiresAt: null,
      });
      account.pointsBalance -= points;
      await this.loyalty.saveAccount(tx, account);
      const payload: LoyaltyPointsRedeemedPayload = {
        userId,
        points,
        amount,
        giftCardId: card.giftCardId,
        giftCardLast4: card.last4,
        pointsBalance: account.pointsBalance,
      };
      await this.outbox.append(tx, [loyaltyEvent(tenantId, LOYALTY_POINTS_REDEEMED, userId, payload)]);
      return { points, amount, pointsBalance: account.pointsBalance, giftCard: { id: card.giftCardId, code: card.code, last4: card.last4, balance: card.balance } };
    });
  }

  /** Ajuste manual del backoffice (positivo o negativo) con motivo; cuenta para el nivel. */
  async adjust(tenantId: string, userId: string, points: number, reason: string) {
    if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 1_000_000) {
      throw new InvalidAdjustmentError('points debe ser un entero distinto de 0 (máximo ±1000000)');
    }
    const motive = reason.trim();
    if (motive.length < 3 || motive.length > 300) throw new InvalidAdjustmentError('El motivo debe tener entre 3 y 300 caracteres');
    return this.db.withTransaction(async (tx) => {
      const tiers = await this.loyalty.listTiers(tx, tenantId);
      await this.loyalty.ensureAccount(tx, tenantId, userId, resolveTier(tiers, 0)?.id ?? null);
      const account = (await this.loyalty.findAccount(tx, tenantId, userId, { forUpdate: true }))!;
      if (points < 0 && account.pointsBalance < -points) throw new InsufficientPointsError(account.pointsBalance, -points);
      await this.loyalty.insertTransaction(tx, { userId, tenantId, type: 'adjust', points, orderId: null, reference: motive, status: 'posted', availableAt: null, expiresAt: null });
      account.pointsBalance += points;
      account.lifetimePoints = Math.max(0, account.lifetimePoints + points);
      await this.promote(tx, tiers, account);
      await this.loyalty.saveAccount(tx, account);
      return { pointsBalance: account.pointsBalance, lifetimePoints: account.lifetimePoints, tierId: account.tierId };
    });
  }

  // ------------------------------------------------------------------ eventos

  /** OrderDelivered → puntos pendientes hasta que venza el plazo de devolución. Idempotente. */
  async onOrderDelivered(tenantId: string, p: OrderDeliveredPayload): Promise<void> {
    if (!p.userId) return; // invitado: no tiene cuenta de puntos
    const order = await this.orders.getOrder(tenantId, p.orderId);
    const base = merchandiseCents(order);
    const deliveredAt = order.deliveredAt ?? new Date(p.deliveredAt);
    const availableAt = new Date(deliveredAt.getTime() + this.config.aftersales.returnWindowDays * DAY_MS);
    await this.db.withTransaction(async (tx) => {
      const tiers = await this.loyalty.listTiers(tx, tenantId);
      await this.loyalty.ensureAccount(tx, tenantId, p.userId!, resolveTier(tiers, 0)?.id ?? null);
      const account = (await this.loyalty.findAccount(tx, tenantId, p.userId!, { forUpdate: true }))!;
      const tier = tiers.find((t) => t.id === account.tierId) ?? resolveTier(tiers, account.lifetimePoints);
      const multiplier = tier?.multiplier ?? '1.00';
      const points = earnPoints(base, this.config.crm.pointsPerUsd, multiplier);
      if (points <= 0) return;
      const saved = await this.loyalty.insertTransaction(tx, {
        userId: p.userId!,
        tenantId,
        type: 'earn',
        points,
        orderId: p.orderId,
        reference: p.orderId,
        status: 'pending',
        availableAt,
        expiresAt: null,
      });
      if (!saved) return; // evento repetido
      account.pointsPending += points;
      await this.loyalty.saveAccount(tx, account);
      const payload: LoyaltyPointsEarnedPayload = {
        userId: p.userId!,
        orderId: p.orderId,
        points,
        multiplier,
        tierName: tier?.name ?? null,
        availableAt: availableAt.toISOString(),
      };
      await this.outbox.append(tx, [loyaltyEvent(tenantId, LOYALTY_POINTS_EARNED, p.userId!, payload)]);
    });
  }

  /**
   * ReturnRefunded → reversa proporcional a lo reembolsado de la mercadería. Si la acumulación
   * sigue pendiente, la reversa también (se netean al acreditar); si ya se acreditó, se descuenta
   * del saldo hasta donde alcance (lo canjeado no se recupera). Idempotente por devolución.
   */
  async onReturnRefunded(tenantId: string, p: ReturnEventPayload): Promise<void> {
    if (!p.userId) return;
    const refundedCents = p.items.reduce((s, i) => s + toCents(i.total), 0);
    if (refundedCents <= 0) return;
    const earn = await this.loyalty.findByReference(this.db, tenantId, 'earn', p.orderId);
    if (!earn) return;
    let order: OrderProps;
    try {
      order = await this.orders.getOrder(tenantId, p.orderId);
    } catch (e) {
      if (e instanceof OrderNotFoundError) return;
      throw e;
    }
    await this.db.withTransaction(async (tx) => {
      const account = await this.loyalty.findAccount(tx, tenantId, earn.userId, { forUpdate: true });
      if (!account) return;
      const txs = await this.loyalty.listOrderTransactions(tx, tenantId, p.orderId);
      if (txs.some((t) => t.type === 'reversal' && t.reference === p.returnId)) return;
      const currentEarn = txs.find((t) => t.type === 'earn')!;
      const reversed = -txs.filter((t) => t.type === 'reversal').reduce((s, t) => s + t.points, 0);
      const points = reversalPoints(currentEarn.points, reversed, merchandiseCents(order), refundedCents);
      if (points === 0) return;
      const pending = currentEarn.status === 'pending';
      const deducted = pending ? points : Math.min(points, account.pointsBalance);
      const saved = await this.loyalty.insertTransaction(tx, {
        userId: earn.userId,
        tenantId,
        type: 'reversal',
        points: -deducted,
        orderId: p.orderId,
        reference: p.returnId,
        status: pending ? 'pending' : 'posted',
        availableAt: pending ? currentEarn.availableAt : null,
        expiresAt: null,
      });
      if (!saved) return;
      if (pending) account.pointsPending = Math.max(0, account.pointsPending - deducted);
      else {
        account.pointsBalance -= deducted;
        account.lifetimePoints = Math.max(0, account.lifetimePoints - deducted);
      }
      await this.loyalty.saveAccount(tx, account);
    });
  }

  // ------------------------------------------------------------------ job

  /**
   * Acredita los puntos de los pedidos cuyo plazo de devolución venció. Un pedido con una
   * devolución abierta se pospone un día (su reembolso todavía puede revertir puntos).
   */
  async matureDue(now = new Date(), tenantId: string | null = null): Promise<MatureResult> {
    const result: MatureResult = { posted: 0, postponed: 0, failed: 0 };
    const seen = new Set<string>();
    for (;;) {
      const due = (await this.loyalty.dueOrders(this.db, now, MATURE_BATCH, tenantId)).filter((d) => !seen.has(d.orderId));
      if (due.length === 0) break;
      for (const d of due) {
        seen.add(d.orderId);
        try {
          const open = await this.orders.listReturns(d.tenantId, { orderId: d.orderId, statuses: UNSETTLED_RETURN_STATUSES, limit: 1, offset: 0 });
          if (open.length > 0) {
            await this.loyalty.postpone(this.db, d.tenantId, d.orderId, new Date(now.getTime() + DAY_MS));
            result.postponed++;
          } else if (await this.post(d.tenantId, d.userId, d.orderId)) result.posted++;
        } catch (e) {
          result.failed++;
          this.logger.error(`Puntos del pedido ${d.orderId}: ${(e as Error).message}`);
        }
      }
      if (due.length < MATURE_BATCH) break;
    }
    return result;
  }

  private async post(tenantId: string, userId: string, orderId: string): Promise<boolean> {
    return this.db.withTransaction(async (tx) => {
      const account = await this.loyalty.findAccount(tx, tenantId, userId, { forUpdate: true });
      if (!account) return false;
      const pending = (await this.loyalty.listOrderTransactions(tx, tenantId, orderId)).filter((t) => t.status === 'pending');
      if (pending.length === 0) return false; // otra réplica ya lo acreditó
      const net = Math.max(0, pending.reduce((s, t) => s + t.points, 0));
      await this.loyalty.setOrderStatus(tx, tenantId, orderId, 'pending', 'posted');
      account.pointsPending = Math.max(0, account.pointsPending - net);
      account.pointsBalance += net;
      account.lifetimePoints += net;
      const tiers = await this.loyalty.listTiers(tx, tenantId);
      await this.promote(tx, tiers, account);
      await this.loyalty.saveAccount(tx, account);
      const payload: LoyaltyPointsPostedPayload = { userId, orderId, points: net, pointsBalance: account.pointsBalance, lifetimePoints: account.lifetimePoints };
      await this.outbox.append(tx, [loyaltyEvent(tenantId, LOYALTY_POINTS_POSTED, userId, payload)]);
      return true;
    });
  }

  /** Sube de nivel si corresponde (cambia account.tierId) y emite LoyaltyTierChanged. */
  private async promote(tx: Queryable, tiers: LoyaltyTier[], account: LoyaltyAccount): Promise<void> {
    const target = promotedTier(tiers, account.tierId, account.lifetimePoints);
    if (!target || target.id === account.tierId) return;
    const from = tiers.find((t) => t.id === account.tierId) ?? null;
    account.tierId = target.id;
    const payload: LoyaltyTierChangedPayload = {
      userId: account.userId,
      fromTierId: from?.id ?? null,
      fromTierName: from?.name ?? null,
      toTierId: target.id,
      toTierName: target.name,
      multiplier: target.multiplier,
      lifetimePoints: account.lifetimePoints,
    };
    await this.outbox.append(tx, [loyaltyEvent(account.tenantId, LOYALTY_TIER_CHANGED, account.userId, payload)]);
  }
}
