import { randomUUID } from 'node:crypto';
import { DomainEvent, fromCents, toCents } from '../../../shared-kernel';
import { InvalidPaymentError, InvalidPaymentTransitionError, VoucherUnderReviewError } from './errors';
import { paymentCaptured, paymentExpired, paymentFailed } from './events';

/** Mismos valores que el CHECK de payments.payments.method. */
export const PAYMENT_METHODS = ['card', 'deuna', 'pichincha', 'transfer', 'qr', 'cod', 'gift_card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Métodos que se cobran en la pasarela (PaymentGatewayPort): el cliente sale a su página de pago. */
export const ONLINE_METHODS: readonly PaymentMethod[] = ['card', 'deuna', 'pichincha', 'qr'];

export type PaymentProvider = 'simulator' | 'datafast' | 'payphone' | 'medianet' | 'deuna' | 'pichincha' | 'manual' | 'internal';

export type PaymentStatus =
  | 'pending'
  | 'requires_action'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'refunded'
  | 'partially_refunded';

/**
 * Estados abiertos: el pago todavía puede capturarse.
 *  - pending: esperando la pasarela, la verificación de la transferencia o la entrega (COD).
 *  - requires_action: el cliente debe actuar (transferir y subir el comprobante).
 */
export const OPEN_STATUSES: ReadonlySet<PaymentStatus> = new Set(['pending', 'requires_action', 'authorized']);

export interface PaymentProps {
  id: string;
  tenantId: string;
  orderId: string;
  method: PaymentMethod;
  provider: PaymentProvider;
  /** numeric(12,2) como string. */
  amount: string;
  currency: string;
  status: PaymentStatus;
  providerRef: string | null;
  authorizationCode: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  idempotencyKey: string;
  failureCode: string | null;
  failureMessage: string | null;
  expiresAt: Date | null;
  capturedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewPayment {
  id?: string;
  tenantId: string;
  orderId: string;
  method: PaymentMethod;
  provider: PaymentProvider;
  amount: string;
  idempotencyKey: string;
  expiresAt: Date | null;
}

/** Fila de payments.payment_events: bitácora de todo lo que le pasó al pago. */
export interface PaymentEventRecord {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface PaymentChange {
  /** false si la operación ya estaba aplicada (idempotencia: webhook repetido, evento repetido). */
  changed: boolean;
  events: DomainEvent[];
  record: PaymentEventRecord | null;
}

export interface CaptureDetails {
  authorizationCode?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  source: string;
}

const UNCHANGED: PaymentChange = { changed: false, events: [], record: null };

/**
 * Agregado Pago. Máquina de estados:
 *
 *   requires_action ──comprobante──▶ pending ──captura──▶ captured
 *         │                            │  └──rechazo──▶ failed
 *         └──────────┬─────────────────┴──vence──▶ expired
 *                    └──pedido cancelado──▶ cancelled
 *
 * Toda operación sobre un estado final (captured, failed, expired, cancelled) se rechaza,
 * salvo repetir la misma, que no hace nada (los webhooks y eventos llegan más de una vez).
 */
export class Payment {
  private constructor(private props: PaymentProps) {}

  static create(input: NewPayment, now = new Date()): Payment {
    if (!(PAYMENT_METHODS as readonly string[]).includes(input.method)) {
      throw new InvalidPaymentError('INVALID_PAYMENT_METHOD', 'Método de pago no soportado', { method: input.method });
    }
    const cents = toCents(input.amount);
    if (cents <= 0) throw new InvalidPaymentError('INVALID_AMOUNT', 'El monto del pago debe ser mayor que 0');
    if (!input.idempotencyKey) throw new InvalidPaymentError('IDEMPOTENCY_KEY_REQUIRED', 'El pago requiere una clave de idempotencia');
    return new Payment({
      id: input.id ?? randomUUID(),
      tenantId: input.tenantId,
      orderId: input.orderId,
      method: input.method,
      provider: input.provider,
      amount: fromCents(cents),
      currency: 'USD',
      // La transferencia espera que el cliente transfiera y suba el comprobante.
      status: input.method === 'transfer' ? 'requires_action' : 'pending',
      providerRef: null,
      authorizationCode: null,
      cardBrand: null,
      cardLast4: null,
      idempotencyKey: input.idempotencyKey,
      failureCode: null,
      failureMessage: null,
      expiresAt: input.expiresAt,
      capturedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: PaymentProps): Payment {
    return new Payment({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get status(): PaymentStatus {
    return this.props.status;
  }
  get method(): PaymentMethod {
    return this.props.method;
  }
  get amount(): string {
    return this.props.amount;
  }
  get isOpen(): boolean {
    return OPEN_STATUSES.has(this.props.status);
  }

  toJSON(): PaymentProps {
    return { ...this.props };
  }

  /** Referencia de la pasarela (se conoce al crear el intent). */
  assignProviderRef(ref: string): void {
    this.props.providerRef = ref;
  }

  isExpiredAt(now: Date): boolean {
    return this.props.expiresAt !== null && this.props.expiresAt.getTime() <= now.getTime();
  }

  /** Pasarela aprobó, transferencia verificada, COD cobrado o gift card. Emite PaymentCaptured. */
  capture(details: CaptureDetails, now = new Date()): PaymentChange {
    if (this.props.status === 'captured') return UNCHANGED;
    this.assertOpen('captured');
    if (this.isExpiredAt(now)) throw new InvalidPaymentTransitionError(this.props.id, 'expired', 'captured');
    const p = this.props;
    p.status = 'captured';
    p.capturedAt = now;
    p.updatedAt = now;
    p.authorizationCode = details.authorizationCode ?? p.authorizationCode;
    p.cardBrand = details.cardBrand ?? p.cardBrand;
    p.cardLast4 = details.cardLast4 ?? p.cardLast4;
    return {
      changed: true,
      events: [paymentCaptured(this.toJSON())],
      record: { eventType: 'captured', payload: { source: details.source, authorizationCode: p.authorizationCode } },
    };
  }

  /** Pasarela rechazó o el backoffice rechazó la transferencia. Emite PaymentFailed. */
  fail(code: string, message: string | null, source: string, now = new Date()): PaymentChange {
    if (this.props.status === 'failed') return UNCHANGED;
    this.assertOpen('failed');
    const p = this.props;
    p.status = 'failed';
    p.failureCode = code;
    p.failureMessage = message;
    p.updatedAt = now;
    return {
      changed: true,
      events: [paymentFailed(this.toJSON())],
      record: { eventType: 'failed', payload: { source, failureCode: code, failureMessage: message } },
    };
  }

  /** Venció sin completarse. Emite PaymentExpired (Pedidos cancela y se libera el stock). */
  expire(now = new Date()): PaymentChange {
    if (this.props.status === 'expired') return UNCHANGED;
    this.assertOpen('expired');
    if (!this.isExpiredAt(now)) throw new InvalidPaymentTransitionError(this.props.id, this.props.status, 'expired');
    this.props.status = 'expired';
    this.props.updatedAt = now;
    return {
      changed: true,
      events: [paymentExpired(this.toJSON(), now)],
      record: { eventType: 'expired', payload: { expiresAt: this.props.expiresAt!.toISOString() } },
    };
  }

  /** El pedido se canceló: el pago abierto ya no debe capturarse. Sin evento (la causa ya lo emitió). */
  cancel(reason: string, now = new Date()): PaymentChange {
    if (!this.isOpen) return UNCHANGED;
    this.props.status = 'cancelled';
    this.props.updatedAt = now;
    return { changed: true, events: [], record: { eventType: 'cancelled', payload: { reason } } };
  }

  /**
   * Se devolvió dinero de este pago (refundedCents = total reembolsado del pago hasta ahora):
   * captured → partially_refunded → refunded. Sin evento: lo emite el reembolso (RefundSucceeded).
   */
  recordRefund(refundedCents: number, now = new Date()): PaymentChange {
    const refundable: PaymentStatus[] = ['captured', 'partially_refunded', 'refunded'];
    if (!refundable.includes(this.props.status)) throw new InvalidPaymentTransitionError(this.props.id, this.props.status, 'refunded');
    if (refundedCents <= 0) return UNCHANGED;
    const next: PaymentStatus = refundedCents >= toCents(this.props.amount) ? 'refunded' : 'partially_refunded';
    if (next === this.props.status) return UNCHANGED;
    this.props.status = next;
    this.props.updatedAt = now;
    return { changed: true, events: [], record: { eventType: 'refund_applied', payload: { refunded: fromCents(refundedCents), status: next } } };
  }

  /** El cliente subió el comprobante de transferencia: queda pendiente de verificación. */
  /**
   * Solo desde requires_action. En pending el backoffice ya está revisando ese comprobante:
   * reemplazarlo cambiaría el archivo que aprueba sin que lo note. Un rechazo deja el pago en
   * failed (final), así que tampoco hay reenvío después de rechazar: el cliente compra de nuevo.
   */
  /** submittedBy: quién lo subió si no fue el cliente (p. ej. 'staff:<id>' en pedidos asistidos). */
  submitTransferVoucher(voucherKey: string, now = new Date(), submittedBy?: string): PaymentChange {
    if (this.props.method !== 'transfer') {
      throw new InvalidPaymentTransitionError(this.props.id, this.props.status, 'pending');
    }
    this.assertOpen('pending');
    if (this.isExpiredAt(now)) throw new InvalidPaymentTransitionError(this.props.id, 'expired', 'pending');
    if (this.props.status !== 'requires_action') throw new VoucherUnderReviewError(this.props.id, this.props.status);
    this.props.status = 'pending';
    this.props.updatedAt = now;
    const payload = submittedBy ? { voucherKey, submittedBy } : { voucherKey };
    return { changed: true, events: [], record: { eventType: 'voucher_submitted', payload } };
  }

  private assertOpen(to: PaymentStatus): void {
    if (!this.isOpen) throw new InvalidPaymentTransitionError(this.props.id, this.props.status, to);
  }
}
