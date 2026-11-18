import { DomainEvent } from '../../../shared-kernel';

export const WISHLIST_BACK_IN_STOCK = 'WishlistBackInStock';
export const WISHLIST_PRICE_DROPPED = 'WishlistPriceDropped';
export const LOYALTY_POINTS_EARNED = 'LoyaltyPointsEarned';
export const LOYALTY_POINTS_POSTED = 'LoyaltyPointsPosted';
export const LOYALTY_POINTS_REDEEMED = 'LoyaltyPointsRedeemed';
export const LOYALTY_TIER_CHANGED = 'LoyaltyTierChanged';
export const REFERRAL_QUALIFIED = 'ReferralQualified';
export const REFERRAL_REWARDED = 'ReferralRewarded';

/**
 * Alertas de la lista de deseos. Consumidor previsto: Notificaciones (mensaje de MARKETING: exige
 * el consentimiento del canal). Precios sin IVA y con IVA, para la plantilla.
 */
export interface WishlistAlertPayload {
  userId: string;
  productId: string;
  variantId: string | null;
  productName: string;
  price: string;
  priceWithTax: string;
  /** Solo en WishlistPriceDropped. */
  previousPrice?: string;
  previousPriceWithTax?: string;
  observedAt: string;
}

/** Consumidores previstos: Notificaciones ("ganaste N puntos, se acreditan el ..."), Reportes. */
export interface LoyaltyPointsEarnedPayload {
  userId: string;
  orderId: string;
  points: number;
  multiplier: string;
  tierName: string | null;
  availableAt: string;
}

export interface LoyaltyPointsPostedPayload {
  userId: string;
  orderId: string;
  points: number;
  pointsBalance: number;
  lifetimePoints: number;
}

export interface LoyaltyPointsRedeemedPayload {
  userId: string;
  points: number;
  amount: string;
  giftCardId: string;
  giftCardLast4: string;
  pointsBalance: number;
}

export interface LoyaltyTierChangedPayload {
  userId: string;
  fromTierId: string | null;
  fromTierName: string | null;
  toTierId: string;
  toTierName: string;
  multiplier: string;
  lifetimePoints: number;
}

export interface ReferralPayload {
  referralId: string;
  referrerId: string;
  refereeId: string;
  orderId: string;
  /** Solo en ReferralRewarded: cupón personal del referente (código y monto). */
  couponCode?: string;
  rewardAmount?: string;
}

function event(tenantId: string, aggregateType: string, aggregateId: string, eventType: string, payload: object): DomainEvent {
  return { tenantId, aggregateType, aggregateId, eventType, payload: { ...payload } };
}

export function wishlistAlert(tenantId: string, eventType: typeof WISHLIST_BACK_IN_STOCK | typeof WISHLIST_PRICE_DROPPED, p: WishlistAlertPayload): DomainEvent {
  // El agregado es el cliente: su wishlist no tiene id propio (PK user_id, product_id).
  return event(tenantId, 'crm.wishlist', p.userId, eventType, p);
}

export function loyaltyEvent(
  tenantId: string,
  eventType: typeof LOYALTY_POINTS_EARNED | typeof LOYALTY_POINTS_POSTED | typeof LOYALTY_POINTS_REDEEMED | typeof LOYALTY_TIER_CHANGED,
  userId: string,
  p: object,
): DomainEvent {
  return event(tenantId, 'crm.loyalty_account', userId, eventType, p);
}

export function referralEvent(tenantId: string, eventType: typeof REFERRAL_QUALIFIED | typeof REFERRAL_REWARDED, p: ReferralPayload): DomainEvent {
  return event(tenantId, 'crm.referral', p.referralId, eventType, p);
}
