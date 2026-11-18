/**
 * API PÚBLICA del módulo Carrito. Otros módulos solo pueden importar desde aquí.
 */
export { CartModule, CartWorkerModule } from './cart.module';
export { CartApi } from './application/cart.api';
export { AbandonedCartService } from './application/abandoned-cart.service';
export type { AbandonedCartRun } from './application/abandoned-cart.service';
export { LAST_REMINDER_STAGE, REMINDER_STAGES } from './domain/abandoned-cart';
export { CART_ABANDONED } from './domain/events';
export type { CartAbandonedLine, CartAbandonedPayload } from './domain/events';
export { CART_COOKIE, readCookie } from './api/cart.controller';
export type { CartDraft, CartOutcome, CartView, CouponStatus } from './application/cart.service';
export type { CartIssue, CartLineView, CartTotals, TaxBreakdown } from './domain/cart-pricing';
export { MAX_COUPONS, MAX_LINES, MAX_QTY_PER_LINE } from './domain/cart';
export {
  CartInsufficientStockError,
  CartNotFoundError,
  CouponRejectedError,
  VariantNotFoundError,
  VariantUnavailableError,
} from './domain/errors';
