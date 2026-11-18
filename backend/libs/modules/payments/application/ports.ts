/**
 * Puertos del módulo Pagos. Persistencia (schema payments) y servicios externos: la pasarela
 * (PaymentGatewayPort, ADR-10) y el almacenamiento de comprobantes de transferencia.
 */
import { ObjectStorage, Queryable } from '../../../shared-kernel';
import { Payment, PaymentEventRecord, PaymentMethod, PaymentProvider, PaymentStatus } from '../domain/payment';
import { Refund, RefundStatus } from '../domain/refund';

export interface LockOption {
  forUpdate?: boolean;
}

export interface PaymentFilter {
  statuses?: PaymentStatus[];
  method?: PaymentMethod;
  orderId?: string;
  limit: number;
  offset: number;
}

export interface PaymentEventEntry {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface BankTransfer {
  paymentId: string;
  bankName: string;
  reference: string | null;
  voucherKey: string | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  rejectionReason: string | null;
}

/** Datos para conciliar una transferencia contra el extracto bancario (cola de verificación). */
export interface TransferReconciliation {
  bankName: string | null;
  /** Referencia que escribió el cliente al subir el comprobante. */
  reference: string | null;
  /** Número de pedido (quedó en el evento 'created' del pago). */
  orderNumber: string | null;
  voucherSubmittedAt: Date | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  rejectionReason: string | null;
}

export abstract class PaymentRepository {
  /** Por id de pago; solo los que tienen algo (transferencias). Una sola consulta para toda la página. */
  abstract listTransferReconciliation(q: Queryable, paymentIds: string[]): Promise<Map<string, TransferReconciliation>>;
  /** false si ya existe un pago con la misma (tenant, idempotency_key). */
  abstract insert(q: Queryable, payment: Payment): Promise<boolean>;
  abstract update(q: Queryable, payment: Payment): Promise<void>;
  abstract findById(q: Queryable, tenantId: string, id: string, opts?: LockOption): Promise<Payment | null>;
  abstract findByIdempotencyKey(q: Queryable, tenantId: string, key: string): Promise<Payment | null>;
  /** Sin tenant: el webhook solo trae la referencia de la pasarela (única por proveedor). */
  abstract findByProviderRef(q: Queryable, provider: string, providerRef: string, opts?: LockOption): Promise<Payment | null>;
  abstract findByOrder(q: Queryable, tenantId: string, orderId: string, opts?: LockOption): Promise<Payment[]>;
  abstract list(q: Queryable, tenantId: string, filter: PaymentFilter): Promise<Payment[]>;
  /** Pagos abiertos con expires_at vencido, bloqueados con SKIP LOCKED (varios workers). */
  abstract claimExpired(q: Queryable, limit: number): Promise<Payment[]>;
  abstract insertEvent(q: Queryable, paymentId: string, record: PaymentEventRecord): Promise<void>;
  abstract listEvents(q: Queryable, paymentId: string): Promise<PaymentEventEntry[]>;
  abstract upsertBankTransfer(
    q: Queryable,
    t: { paymentId: string; bankName: string; reference: string | null; voucherKey: string },
  ): Promise<void>;
  abstract findBankTransfer(q: Queryable, paymentId: string): Promise<BankTransfer | null>;
  abstract reviewBankTransfer(q: Queryable, paymentId: string, reviewerId: string, rejectionReason: string | null): Promise<void>;
}

export interface WebhookInboxRow {
  id: string;
  provider: string;
  externalId: string;
  signatureValid: boolean;
  processedAt: Date | null;
  error: string | null;
}

export abstract class WebhookInboxRepository {
  /** INSERT ... ON CONFLICT (provider, external_id) DO NOTHING. null si ya existía. */
  abstract insert(
    q: Queryable,
    row: { provider: string; externalId: string; payload: unknown; signatureValid: boolean; error: string | null },
  ): Promise<string | null>;
  abstract findForUpdate(q: Queryable, provider: string, externalId: string): Promise<WebhookInboxRow | null>;
  /** Llegó con firma válida un id que antes solo se había recibido con firma inválida. */
  abstract replaceWithValid(q: Queryable, id: string, payload: unknown): Promise<void>;
  abstract markProcessed(q: Queryable, id: string, error: string | null): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Pasarela de pago
// ---------------------------------------------------------------------------------------

export interface CreateIntentInput {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  method: PaymentMethod;
  amount: string;
  currency: string;
  expiresAt: Date;
  returnUrl: string;
}

export interface PaymentIntent {
  providerRef: string;
  /** Página de pago de la pasarela a la que se redirige al cliente. */
  redirectUrl: string;
}

/** Notificación de la pasarela, ya traducida al lenguaje del dominio. */
export interface GatewayNotification {
  /** Id del evento en la pasarela: clave de idempotencia de webhook_inbox. */
  externalId: string;
  providerRef: string;
  outcome: 'approved' | 'rejected';
  amount: string;
  currency: string;
  authorizationCode: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface GatewayRefundInput {
  refundId: string;
  paymentId: string;
  /** Referencia del cobro en la pasarela. */
  providerRef: string;
  amount: string;
  currency: string;
}

/** La pasarela rechazó el reverso (monto mayor al cobrado, cobro desconocido...). */
export class GatewayRefundRejectedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'GatewayRefundRejectedError';
  }
}

/**
 * Puerto de la pasarela de pago (arquitectura hexagonal). El simulador es el único adaptador
 * del proyecto; Datafast, Payphone, DeUna, etc. serían otras clases que implementan lo mismo.
 */
export abstract class PaymentGatewayPort {
  abstract readonly provider: PaymentProvider;
  /** Métodos que esta pasarela cobra. */
  abstract readonly methods: readonly PaymentMethod[];
  /** No debe hacer I/O lento: se llama dentro de la transacción del checkout. */
  abstract createIntent(input: CreateIntentInput): Promise<PaymentIntent>;
  /**
   * Reverso (total o parcial) de un pago capturado. Hace I/O: llamar FUERA de una transacción.
   * Idempotente por refundId. Lanza GatewayRefundRejectedError si la pasarela lo rechaza (no
   * sirve reintentar); cualquier otro error es transitorio.
   */
  abstract refund(input: GatewayRefundInput): Promise<{ providerRef: string }>;
  /** Verifica la firma (HMAC) y la frescura del webhook sobre el cuerpo CRUDO. */
  abstract verifyWebhook(rawBody: Buffer, headers: WebhookHeaders): boolean;
  /** Lanza InvalidPaymentError si el cuerpo no tiene el formato de la pasarela. */
  abstract parseWebhook(rawBody: Buffer): GatewayNotification;
}

// ---------------------------------------------------------------------------------------
// Comprobantes de transferencia
// ---------------------------------------------------------------------------------------

/** Token de inyección de Pagos para el ObjectStorage compartido (shared kernel). */
export abstract class VoucherStorage extends ObjectStorage {}

// ---------------------------------------------------------------------------------------
// Reembolsos
// ---------------------------------------------------------------------------------------

export interface RefundFilter {
  statuses?: RefundStatus[];
  orderId?: string;
  returnId?: string;
  limit: number;
  offset: number;
}

/**
 * payments.refunds + la bitácora del pago (payment_events) para lo que la tabla no tiene:
 * aprobaciones, plan de ejecución, partes ejecutadas y motivo de falla.
 */
export abstract class RefundRepository {
  /** false si la devolución ya tiene reembolso (índice único ux_refunds_return). */
  abstract insert(q: Queryable, refund: Refund): Promise<boolean>;
  /** Guarda estado, aprobador, referencia y cierre; registra en la bitácora lo nuevo (aprobaciones, plan, partes). */
  abstract save(q: Queryable, refund: Refund): Promise<void>;
  abstract findById(q: Queryable, tenantId: string, id: string, opts?: LockOption): Promise<Refund | null>;
  abstract findByReturn(q: Queryable, tenantId: string, returnId: string): Promise<Refund | null>;
  abstract list(q: Queryable, tenantId: string, filter: RefundFilter): Promise<Refund[]>;
  /** Reembolsos del pago (para calcular cuánto salió ya por la pasarela o por transferencia). */
  abstract listByPayment(q: Queryable, paymentId: string): Promise<Refund[]>;
  /** Suma de los reembolsos exitosos de los pagos del pedido. */
  abstract succeededTotalForOrder(q: Queryable, tenantId: string, orderId: string): Promise<string>;
  /** En processing con el reverso por pasarela pendiente (job de reintentos). */
  abstract listPendingGateway(q: Queryable, limit: number): Promise<Refund[]>;
}
