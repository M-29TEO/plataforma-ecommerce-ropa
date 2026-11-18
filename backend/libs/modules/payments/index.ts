/**
 * API PÚBLICA del módulo Pagos. Otros módulos solo pueden importar desde aquí.
 */
export { PaymentsConsumersModule, PaymentsModule, PaymentsWorkerModule } from './payments.module';
export { PaymentsApi } from './application/payments.api';
export type { CreatePaymentInput, NextAction, PaymentCreated, PublicPaymentView } from './application/payment.service';
export { VOUCHER_MAX_BYTES } from './application/transfer.service';
export type { VoucherFile, VoucherInput } from './application/transfer.service';
export type { ApproveRefundResult, RefundView, RequestRefundInput } from './application/refund.service';
export type { ApprovalOutcome, RefundMethod, RefundPart, RefundPlan, RefundStatus } from './domain/refund';
export { ONLINE_METHODS, PAYMENT_METHODS } from './domain/payment';
export type { PaymentMethod, PaymentStatus } from './domain/payment';
export * from './events';
export {
  InvalidPaymentError,
  InvalidPaymentTransitionError,
  InvalidRefundError,
  InvalidRefundTransitionError,
  PaymentNotFoundError,
  RefundApprovalError,
  RefundNotFoundError,
  RefundNotPossibleError,
} from './domain/errors';
