/**
 * Puertos de persistencia del módulo Promociones (schema sales: promotions, coupons,
 * promotion_redemptions, gift_cards, gift_card_transactions). Mismo criterio que los otros
 * módulos: clases abstractas como tokens de Nest y el Queryable de la transacción en curso.
 */
import { Queryable } from '../../../shared-kernel';
import { GiftCard, GiftCardStatus, GiftCardTransaction, GiftCardTransactionType } from '../domain/gift-card';
import { CouponProps, PromotionBenefit, PromotionConditions, PromotionProps, PromotionType } from '../domain/promotion';

export interface PromotionPatch {
  name?: string;
  conditions?: PromotionConditions;
  benefit?: PromotionBenefit;
  requiresCoupon?: boolean;
  stackable?: boolean;
  priority?: number;
  maxUses?: number | null;
  startsAt?: Date;
  endsAt?: Date | null;
  active?: boolean;
}

export interface PromotionFilter {
  active?: boolean;
  type?: PromotionType;
  limit: number;
  offset: number;
}

export interface Redemption {
  id: string;
  promotionId: string;
  couponId: string | null;
  orderId: string;
  userId: string | null;
  customerKey: string;
  discount: string;
  createdAt: Date;
}

export type NewRedemption = Omit<Redemption, 'id' | 'createdAt'>;

export abstract class PromotionRepository {
  abstract insert(q: Queryable, p: PromotionProps): Promise<void>;
  abstract findById(q: Queryable, tenantId: string, id: string): Promise<PromotionProps | null>;
  abstract list(q: Queryable, tenantId: string, filter: PromotionFilter): Promise<PromotionProps[]>;
  /** Promoción de sistema con cupón (por nombre) de las recompensas, p. ej. referidos. Incluye inactivas. */
  abstract findRewardPromotion(q: Queryable, tenantId: string, name: string): Promise<PromotionProps | null>;
  abstract update(q: Queryable, tenantId: string, id: string, patch: PromotionPatch): Promise<PromotionProps | null>;
  /** Automáticas (sin cupón) activas y vigentes en `now`. */
  abstract findAutomatic(q: Queryable, tenantId: string, now: Date): Promise<PromotionProps[]>;

  abstract insertCoupon(q: Queryable, c: CouponProps): Promise<void>;
  abstract listCoupons(q: Queryable, tenantId: string, promotionId: string): Promise<CouponProps[]>;
  /** Cupones por código (sin distinguir mayúsculas) junto con su promoción. */
  abstract findCouponsByCodes(
    q: Queryable,
    tenantId: string,
    codes: string[],
  ): Promise<{ coupon: CouponProps; promotion: PromotionProps }[]>;
  /**
   * Canjes previos por cupón hechos por el cliente (cualquiera de sus claves o su usuario).
   * excludeOrderId descarta los del propio pedido (reintento simultáneo del mismo checkout).
   */
  abstract countCustomerUses(
    q: Queryable,
    couponIds: string[],
    customerKeys: string[],
    userId: string | null,
    excludeOrderId?: string,
  ): Promise<Map<string, number>>;

  /**
   * UPDATE condicional atómico: used_count + 1 solo si quedan usos. Devuelve el cupón
   * actualizado o null si ya no quedaban. Deja la fila bloqueada hasta el fin de la transacción.
   */
  abstract takeCouponUse(q: Queryable, tenantId: string, couponId: string, promotionId: string): Promise<CouponProps | null>;
  /** Igual para la promoción; además exige que esté activa y vigente en la hora de la base. */
  abstract takePromotionUse(q: Queryable, tenantId: string, promotionId: string): Promise<boolean>;
  abstract releaseCouponUse(q: Queryable, couponId: string): Promise<void>;
  abstract releasePromotionUse(q: Queryable, promotionId: string): Promise<void>;

  abstract insertRedemptions(q: Queryable, rows: NewRedemption[]): Promise<void>;
  abstract findRedemptionsByOrder(q: Queryable, tenantId: string, orderId: string, opts?: { forUpdate?: boolean }): Promise<Redemption[]>;
  abstract deleteRedemptions(q: Queryable, ids: string[]): Promise<void>;
}

export interface GiftCardTransactionRow extends GiftCardTransaction {
  id: string;
}

export interface GiftCardFilter {
  status?: GiftCardStatus;
  limit: number;
  offset: number;
}

export abstract class GiftCardRepository {
  /** Devuelve false si el hash del código ya existe (colisión: se genera otro). */
  abstract insert(q: Queryable, card: GiftCard): Promise<boolean>;
  abstract findById(q: Queryable, tenantId: string, id: string, opts?: { forUpdate?: boolean }): Promise<GiftCard | null>;
  abstract findByCodeHash(q: Queryable, tenantId: string, codeHash: Buffer, opts?: { forUpdate?: boolean }): Promise<GiftCard | null>;
  abstract list(q: Queryable, tenantId: string, filter: GiftCardFilter): Promise<GiftCard[]>;
  /** Persiste balance y status. */
  abstract save(q: Queryable, card: GiftCard): Promise<void>;
  abstract insertTransaction(q: Queryable, tx: GiftCardTransaction): Promise<void>;
  abstract listTransactions(q: Queryable, giftCardId: string): Promise<GiftCardTransactionRow[]>;
  abstract findOrderTransactions(
    q: Queryable,
    tenantId: string,
    orderId: string,
    types?: GiftCardTransactionType[],
  ): Promise<GiftCardTransactionRow[]>;
}

/** Gift card recién emitida: el único momento en que se conoce el código en claro. */
export interface IssuedGiftCard {
  giftCardId: string;
  last4: string;
  balance: string;
  code: string;
}
