/**
 * API PÚBLICA del módulo Promociones. Otros módulos solo pueden importar desde aquí.
 */
export { PromotionsConsumersModule, PromotionsModule } from './promotions.module';
export { PromotionsApi } from './application/promotions.api';
export type { AppliedPromotionView, EvaluateInput, PricingLineInput, PricingResult } from './application/pricing.service';
export type { RedeemInput } from './application/redemption.service';
export type { IssuedRewardCoupon, RewardCouponInput } from './application/promotion.service';
export type { IssuedGiftCard, Redemption } from './application/ports';
export type { GiftCardBalance, GiftCardRedemption } from './application/gift-card.service';
export type { CouponRejection, RejectionReason } from './domain/engine';
export { isValidCouponCode, normalizeCouponCode, PROMOTION_TYPES } from './domain/promotion';
export type { PromotionType } from './domain/promotion';
export {
  CustomerIdentityRequiredError,
  GiftCardInsufficientBalanceError,
  GiftCardNotFoundError,
  GiftCardNotUsableError,
  RedemptionRejectedError,
} from './domain/errors';
