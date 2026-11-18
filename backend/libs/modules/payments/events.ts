/**
 * Contratos de eventos del módulo Pagos (nombres y payloads): segunda API pública, sin dependencias de
 * Nest ni de la base. La usan los consumidores de otros módulos para suscribirse sin cargar el módulo
 * entero, así dos módulos pueden escuchar los eventos del otro sin formar un ciclo de imports.
 */
export { PAYMENT_CAPTURED, PAYMENT_EXPIRED, PAYMENT_FAILED, REFUND_FAILED, REFUND_REQUESTED, REFUND_SUCCEEDED } from './domain/events';
export type {
  PaymentCapturedPayload,
  PaymentExpiredPayload,
  PaymentFailedPayload,
  RefundFailedPayload,
  RefundRequestedPayload,
  RefundSucceededPayload,
} from './domain/events';
