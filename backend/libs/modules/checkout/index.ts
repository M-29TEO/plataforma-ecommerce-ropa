/**
 * API PÚBLICA del módulo Checkout.
 */
export { CheckoutModule } from './checkout.module';
export type { CheckoutCommand, CheckoutResult, DeliveryOptionsCommand } from './application/checkout.service';
export { CHECKOUT_PAYMENT_METHODS } from './domain/checkout';
export type { CheckoutPaymentMethod } from './domain/checkout';
export { CartNotReadyError, CheckoutTotalChangedError } from './domain/checkout';
export { ASSISTED_PAYMENT_METHODS } from './domain/assisted-order';
export type { AssistedPaymentMethod } from './domain/assisted-order';
