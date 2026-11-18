/**
 * API PÚBLICA del módulo CRM y Fidelización. Otros módulos solo pueden importar desde aquí.
 */
export { CrmConsumersModule, CrmModule, CrmWorkerModule } from './crm.module';
export { CrmApi } from './application/crm.api';
export type { CheckoutAddress, CustomerAddress } from './application/crm.api';
export {
  LOYALTY_POINTS_EARNED,
  LOYALTY_POINTS_POSTED,
  LOYALTY_POINTS_REDEEMED,
  LOYALTY_TIER_CHANGED,
  REFERRAL_QUALIFIED,
  REFERRAL_REWARDED,
  WISHLIST_BACK_IN_STOCK,
  WISHLIST_PRICE_DROPPED,
} from './domain/events';
export type {
  LoyaltyPointsEarnedPayload,
  LoyaltyPointsPostedPayload,
  LoyaltyPointsRedeemedPayload,
  LoyaltyTierChangedPayload,
  ReferralPayload,
  WishlistAlertPayload,
} from './domain/events';
export { AddressNotFoundError, AddressWithoutLocationError } from './domain/errors';
