import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, OutboxWriter, Queryable } from '../../../shared-kernel';
import { InvalidPaymentError, PaymentNotFoundError } from '../domain/errors';
import { ONLINE_METHODS, Payment, PaymentChange, PaymentMethod, PaymentProps, PaymentProvider } from '../domain/payment';
import { PaymentSecrets } from './payment-secrets';
import { BankTransfer, PaymentEventEntry, PaymentFilter, PaymentGatewayPort, PaymentRepository, TransferReconciliation } from './ports';

export interface CreatePaymentInput {
  tenantId: string;
  orderId: string;
  orderNumber: string;
  method: PaymentMethod;
  amount: string;
  /** Clave de idempotencia del pago (UNIQUE (tenant_id, idempotency_key)). */
  idempotencyKey: string;
  /**
   * Plazo propio en segundos (pedidos asistidos: enlace de pago enviado por WhatsApp). Solo para
   * métodos que vencen (en línea y transferencia); sin él, el plazo por defecto del método.
   */
  ttlSeconds?: number | null;
}

/** Referencia que se pide al cliente en la transferencia (y que el backoffice busca en el extracto). */
export function transferReference(paymentId: string): string {
  return `PAGO-${paymentId.slice(0, 8).toUpperCase()}`;
}

export type TransferListInfo = TransferReconciliation & { expectedReference: string };

/** Qué debe hacer el cliente después del checkout. */
export type NextAction =
  | { type: 'redirect'; url: string }
  | { type: 'bank_transfer'; account: string; reference: string; expiresAt: string | null }
  | { type: 'cash_on_delivery' }
  | { type: 'none' };

/** Lo que ve el cliente de su pago (sin idempotency key ni referencias internas). */
export interface PublicPaymentView {
  id: string;
  orderId: string;
  method: PaymentMethod;
  status: PaymentProps['status'];
  amount: string;
  currency: string;
  expiresAt: Date | null;
  capturedAt: Date | null;
  cardBrand: string | null;
  cardLast4: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface PaymentCreated {
  payment: PublicPaymentView;
  clientSecret: string;
  nextAction: NextAction;
}

export type PaymentDetail = PaymentProps & { events: PaymentEventEntry[]; bankTransfer: BankTransfer | null };

const EXPIRE_BATCH_SIZE = 100;
const EXPIRE_MAX_BATCHES = 20;

export function publicView(p: PaymentProps): PublicPaymentView {
  return {
    id: p.id,
    orderId: p.orderId,
    method: p.method,
    status: p.status,
    amount: p.amount,
    currency: p.currency,
    expiresAt: p.expiresAt,
    capturedAt: p.capturedAt,
    cardBrand: p.cardBrand,
    cardLast4: p.cardLast4,
    failureCode: p.failureCode,
    failureMessage: p.failureMessage,
  };
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly db: Database,
    private readonly payments: PaymentRepository,
    private readonly gateway: PaymentGatewayPort,
    private readonly secrets: PaymentSecrets,
    private readonly outbox: OutboxWriter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Crea el pago del pedido (lo llama Checkout dentro de su transacción). Idempotente por
   * idempotencyKey: un reintento devuelve el pago existente con la misma acción siguiente.
   *
   *  - card/deuna/pichincha/qr → pasarela (intent + redirección), vence en PAYMENT_ONLINE_TTL_MINUTES.
   *  - transfer → requires_action (transferir y subir comprobante), vence en PAYMENT_TRANSFER_TTL_HOURS.
   *  - cod → pending sin vencimiento: se cobra al entregar.
   *  - gift_card → la gift card cubrió todo: capturado en el acto.
   */
  create(input: CreatePaymentInput, now = new Date()): Promise<PaymentCreated> {
    return this.db.withTransaction(async (tx) => {
      const existing = await this.payments.findByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
      if (existing) return this.created(existing, input.orderNumber);

      const payment = Payment.create(
        {
          tenantId: input.tenantId,
          orderId: input.orderId,
          method: input.method,
          provider: this.providerFor(input.method),
          amount: input.amount,
          idempotencyKey: input.idempotencyKey,
          expiresAt: this.expiresAtFor(input.method, now, input.ttlSeconds ?? null),
        },
        now,
      );
      if (ONLINE_METHODS.includes(input.method)) {
        const intent = await this.gateway.createIntent(this.intentInput(payment.toJSON(), input.orderNumber));
        payment.assignProviderRef(intent.providerRef);
      }
      if (!(await this.payments.insert(tx, payment))) {
        // Otro reintento con la misma clave lo insertó primero.
        const winner = await this.payments.findByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
        if (!winner) throw new Error('Pago no encontrado tras conflicto de idempotencia');
        return this.created(winner, input.orderNumber);
      }
      await this.payments.insertEvent(tx, payment.id, {
        eventType: 'created',
        payload: { method: input.method, amount: payment.amount, orderNumber: input.orderNumber, providerRef: payment.toJSON().providerRef },
      });
      if (input.method === 'gift_card') await this.apply(tx, payment, payment.capture({ source: 'gift_card' }, now));
      return this.created(payment, input.orderNumber);
    });
  }

  /** Estado del pago para quien tiene el client secret (página de resultado, invitado incluido). */
  async getPublic(tenantId: string, paymentId: string, secret: string | undefined): Promise<PaymentCreated> {
    const payment = await this.payments.findById(this.db, tenantId, paymentId);
    if (!payment || !this.secrets.verify(paymentId, secret)) throw new PaymentNotFoundError({ paymentId });
    // El número de pedido (para reabrir la página de pago) quedó en la bitácora al crear el pago.
    const createdEvent = (await this.payments.listEvents(this.db, paymentId)).find((e) => e.eventType === 'created');
    const orderNumber = createdEvent?.payload.orderNumber;
    return this.created(payment, typeof orderNumber === 'string' ? orderNumber : null);
  }

  async get(tenantId: string, paymentId: string): Promise<PaymentDetail> {
    const payment = await this.payments.findById(this.db, tenantId, paymentId);
    if (!payment) throw new PaymentNotFoundError({ paymentId });
    const [events, bankTransfer] = await Promise.all([
      this.payments.listEvents(this.db, paymentId),
      this.payments.findBankTransfer(this.db, paymentId),
    ]);
    return { ...payment.toJSON(), events, bankTransfer };
  }

  /**
   * Listado del backoffice. Las transferencias traen `transfer` con lo necesario para conciliar contra
   * el extracto (referencia esperada PAGO-XXXXXXXX, la del cliente, número de pedido y fecha del
   * comprobante); el resto de métodos, `transfer: null`.
   */
  async list(tenantId: string, filter: PaymentFilter): Promise<Array<PaymentProps & { transfer: TransferListInfo | null }>> {
    const limit = Math.min(Math.max(filter.limit, 1), 100);
    const payments = (await this.payments.list(this.db, tenantId, { ...filter, limit })).map((p) => p.toJSON());
    const transferIds = payments.filter((p) => p.method === 'transfer').map((p) => p.id);
    const info = await this.payments.listTransferReconciliation(this.db, transferIds);
    return payments.map((p) => {
      const t = info.get(p.id);
      return { ...p, transfer: t ? { expectedReference: transferReference(p.id), ...t } : null };
    });
  }

  /**
   * Vence los pagos abiertos cuyo plazo pasó (job cada minuto). Cada lote es una transacción con
   * SKIP LOCKED: un webhook que está capturando el pago en ese momento lo tiene bloqueado y el job
   * lo salta. PaymentExpired → Pedidos cancela → Inventario libera la reserva.
   */
  async expirePending(now = new Date()): Promise<{ expired: number }> {
    let expired = 0;
    for (let batch = 0; batch < EXPIRE_MAX_BATCHES; batch++) {
      const count = await this.db.withTransaction(async (tx) => {
        const rows = await this.payments.claimExpired(tx, EXPIRE_BATCH_SIZE);
        for (const payment of rows) await this.apply(tx, payment, payment.expire(now));
        return rows.length;
      });
      expired += count;
      if (count < EXPIRE_BATCH_SIZE) break;
    }
    if (expired > 0) this.logger.log(`Pagos vencidos: ${expired}`);
    return { expired };
  }

  /** OrderCancelled: los pagos abiertos del pedido ya no pueden capturarse. Idempotente. */
  cancelOpenForOrder(tenantId: string, orderId: string, reason: string): Promise<{ cancelled: number }> {
    return this.db.withTransaction(async (tx) => {
      let cancelled = 0;
      for (const payment of await this.payments.findByOrder(tx, tenantId, orderId, { forUpdate: true })) {
        const change = payment.cancel(reason);
        if (change.changed) cancelled++;
        await this.apply(tx, payment, change);
      }
      return { cancelled };
    });
  }

  /** OrderDelivered de un pedido contra entrega: el motorizado cobró. Idempotente. */
  captureCashOnDelivery(tenantId: string, orderId: string, now = new Date()): Promise<{ captured: number }> {
    return this.db.withTransaction(async (tx) => {
      let captured = 0;
      for (const payment of await this.payments.findByOrder(tx, tenantId, orderId, { forUpdate: true })) {
        if (payment.method !== 'cod' || !payment.isOpen) continue;
        await this.apply(tx, payment, payment.capture({ source: 'cash_on_delivery' }, now));
        captured++;
      }
      return { captured };
    });
  }

  /** Persiste un cambio del agregado: fila, bitácora y eventos del outbox en la misma transacción. */
  async apply(tx: Queryable, payment: Payment, change: PaymentChange): Promise<void> {
    if (!change.changed) return;
    await this.payments.update(tx, payment);
    if (change.record) await this.payments.insertEvent(tx, payment.id, change.record);
    await this.outbox.append(tx, change.events);
  }

  private async created(payment: Payment, orderNumber: string | null): Promise<PaymentCreated> {
    const p = payment.toJSON();
    return { payment: publicView(p), clientSecret: this.secrets.issue(p.id), nextAction: await this.nextAction(p, orderNumber) };
  }

  private async nextAction(p: PaymentProps, orderNumber: string | null): Promise<NextAction> {
    const open = p.status === 'pending' || p.status === 'requires_action';
    if (ONLINE_METHODS.includes(p.method) && open && orderNumber !== null) {
      const intent = await this.gateway.createIntent(this.intentInput(p, orderNumber));
      return { type: 'redirect', url: intent.redirectUrl };
    }
    if (p.method === 'transfer' && open) {
      return {
        type: 'bank_transfer',
        account: this.config.payments.transferAccount,
        reference: transferReference(p.id),
        expiresAt: p.expiresAt?.toISOString() ?? null,
      };
    }
    if (p.method === 'cod' && open) return { type: 'cash_on_delivery' };
    return { type: 'none' };
  }

  private intentInput(p: PaymentProps, orderNumber: string) {
    if (!p.expiresAt) throw new InvalidPaymentError('EXPIRY_REQUIRED', 'Un pago en línea requiere vencimiento');
    return {
      paymentId: p.id,
      orderId: p.orderId,
      orderNumber,
      method: p.method,
      amount: p.amount,
      currency: p.currency,
      expiresAt: p.expiresAt,
      returnUrl: `${this.config.payments.returnUrl}?paymentId=${p.id}`,
    };
  }

  private providerFor(method: PaymentMethod): PaymentProvider {
    if (ONLINE_METHODS.includes(method)) {
      if (!this.gateway.methods.includes(method)) {
        throw new InvalidPaymentError('METHOD_NOT_SUPPORTED', 'La pasarela configurada no cobra este método', { method });
      }
      return this.gateway.provider;
    }
    return method === 'gift_card' ? 'internal' : 'manual';
  }

  private expiresAtFor(method: PaymentMethod, now: Date, ttlSeconds: number | null): Date | null {
    const fallback = this.paymentTtlSeconds(method);
    if (ttlSeconds === null) return fallback === null ? null : new Date(now.getTime() + fallback * 1000);
    if (fallback === null) {
      throw new InvalidPaymentError('EXPIRY_NOT_ALLOWED', 'Este método de pago no vence', { method });
    }
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60) {
      throw new InvalidPaymentError('INVALID_EXPIRY', 'El plazo del pago debe ser de al menos 60 s', { ttlSeconds });
    }
    return new Date(now.getTime() + ttlSeconds * 1000);
  }

  /** Vencimiento que tendrá un pago de este método (Checkout reserva el stock un poco más). */
  paymentTtlSeconds(method: PaymentMethod): number | null {
    const { onlineTtlMinutes, transferTtlHours } = this.config.payments;
    if (ONLINE_METHODS.includes(method)) return onlineTtlMinutes * 60;
    if (method === 'transfer') return transferTtlHours * 3600;
    return null;
  }
}
