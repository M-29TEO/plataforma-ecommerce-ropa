import { ConflictError, NotFoundError, ValidationError } from '../../../shared-kernel';

export class PaymentNotFoundError extends NotFoundError {
  constructor(details: Record<string, unknown>) {
    super('PAYMENT_NOT_FOUND', 'Pago no encontrado', details);
  }
}

/** El pago ya no admite la operación (p. ej. capturar un pago vencido o rechazado). */
export class InvalidPaymentTransitionError extends ConflictError {
  constructor(paymentId: string, from: string, to: string) {
    super('INVALID_PAYMENT_TRANSITION', `Un pago en estado "${from}" no puede pasar a "${to}"`, { paymentId, from, to });
  }
}

export class InvalidPaymentError extends ValidationError {}

/** Operación de transferencia sobre un pago de otro método, o sin comprobante. */
export class TransferOperationError extends ConflictError {}

export class InvalidVoucherError extends ValidationError {}

/** El comprobante ya está en revisión (pending): no se reemplaza bajo los ojos del backoffice. */
export class VoucherUnderReviewError extends ConflictError {
  constructor(paymentId: string, status: string) {
    super('VOUCHER_ALREADY_SUBMITTED', 'El comprobante ya fue enviado y está en revisión', { paymentId, status });
  }
}

export class GatewayNotConfiguredError extends NotFoundError {
  constructor(provider: string) {
    super('GATEWAY_NOT_FOUND', 'Pasarela de pago desconocida', { provider });
  }
}

export class RefundNotFoundError extends NotFoundError {
  constructor(details: Record<string, unknown>) {
    super('REFUND_NOT_FOUND', 'Reembolso no encontrado', details);
  }
}

export class InvalidRefundError extends ValidationError {}

/** El reembolso no admite la operación en su estado actual. */
export class InvalidRefundTransitionError extends ConflictError {
  constructor(refundId: string, from: string, to: string) {
    super('INVALID_REFUND_TRANSITION', `Un reembolso en estado "${from}" no puede pasar a "${to}"`, { refundId, from, to });
  }
}

/** Autoaprobación o segunda aprobación de la misma persona. */
export class RefundApprovalError extends ConflictError {}

/** El pedido no tiene un pago cobrado sobre el cual reembolsar. */
export class RefundNotPossibleError extends ConflictError {}
