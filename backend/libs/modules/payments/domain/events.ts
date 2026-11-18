import { DomainEvent } from '../../../shared-kernel';
import type { PaymentProps } from './payment';

export const PAYMENT_CAPTURED = 'PaymentCaptured';
export const PAYMENT_FAILED = 'PaymentFailed';
export const PAYMENT_EXPIRED = 'PaymentExpired';

const AGGREGATE_TYPE = 'payments.payment';

/** Consumidores: Pedidos (→ paid), Notificaciones. */
export interface PaymentCapturedPayload {
  paymentId: string;
  orderId: string;
  method: string;
  provider: string;
  amount: string;
  currency: string;
  capturedAt: string;
}

/** Rechazo de la pasarela o transferencia rechazada. Consumidores: Pedidos (cancela), Notificaciones. */
export interface PaymentFailedPayload {
  paymentId: string;
  orderId: string;
  method: string;
  provider: string;
  amount: string;
  failureCode: string;
  failureMessage: string | null;
}

/** El cliente no completó el pago a tiempo. Consumidores: Pedidos (cancela → se libera el stock). */
export interface PaymentExpiredPayload {
  paymentId: string;
  orderId: string;
  method: string;
  amount: string;
  expiredAt: string;
}

function event(p: PaymentProps, eventType: string, payload: object): DomainEvent {
  return { tenantId: p.tenantId, aggregateType: AGGREGATE_TYPE, aggregateId: p.id, eventType, payload: { ...payload } };
}

export function paymentCaptured(p: PaymentProps): DomainEvent {
  const payload: PaymentCapturedPayload = {
    paymentId: p.id,
    orderId: p.orderId,
    method: p.method,
    provider: p.provider,
    amount: p.amount,
    currency: p.currency,
    capturedAt: p.capturedAt!.toISOString(),
  };
  return event(p, PAYMENT_CAPTURED, payload);
}

export function paymentFailed(p: PaymentProps): DomainEvent {
  const payload: PaymentFailedPayload = {
    paymentId: p.id,
    orderId: p.orderId,
    method: p.method,
    provider: p.provider,
    amount: p.amount,
    failureCode: p.failureCode!,
    failureMessage: p.failureMessage,
  };
  return event(p, PAYMENT_FAILED, payload);
}

export function paymentExpired(p: PaymentProps, now: Date): DomainEvent {
  const payload: PaymentExpiredPayload = {
    paymentId: p.id,
    orderId: p.orderId,
    method: p.method,
    amount: p.amount,
    expiredAt: now.toISOString(),
  };
  return event(p, PAYMENT_EXPIRED, payload);
}

export const REFUND_REQUESTED = 'RefundRequested';
export const REFUND_SUCCEEDED = 'RefundSucceeded';
export const REFUND_FAILED = 'RefundFailed';

const REFUND_AGGREGATE = 'payments.refund';

/** Consumidores previstos: Notificaciones (avisar a quienes aprueban). */
export interface RefundRequestedPayload {
  refundId: string;
  paymentId: string;
  orderId: string;
  returnId: string | null;
  amount: string;
  method: string;
  requiredApprovals: number;
}

/**
 * Consumidores: Pedidos (devolución → refunded; pedido → partially_refunded / refunded) y
 * Facturación (nota de crédito de la devolución), Notificaciones.
 */
export interface RefundSucceededPayload {
  refundId: string;
  paymentId: string;
  orderId: string;
  returnId: string | null;
  amount: string;
  method: string;
  /** Todo lo reembolsado del pedido hasta ahora, este reembolso incluido. */
  orderRefundedTotal: string;
  completedAt: string;
}

/** La pasarela rechazó el reverso. Consumidores previstos: Notificaciones, Soporte. */
export interface RefundFailedPayload {
  refundId: string;
  paymentId: string;
  orderId: string;
  returnId: string | null;
  amount: string;
  reason: string;
}

export function refundEvent(
  tenantId: string,
  eventType: string,
  payload: RefundRequestedPayload | RefundSucceededPayload | RefundFailedPayload,
): DomainEvent {
  return { tenantId, aggregateType: REFUND_AGGREGATE, aggregateId: payload.refundId, eventType, payload: { ...payload } };
}
