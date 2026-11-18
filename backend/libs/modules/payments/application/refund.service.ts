import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, OutboxWriter, Queryable, toCents } from '../../../shared-kernel';
import { InvalidRefundError, PaymentNotFoundError, RefundNotFoundError, RefundNotPossibleError } from '../domain/errors';
import { REFUND_FAILED, REFUND_REQUESTED, REFUND_SUCCEEDED, refundEvent } from '../domain/events';
import { Payment, PaymentMethod } from '../domain/payment';
import { ApprovalOutcome, Refund, refundMethodFor, RefundPart, RefundPlan, RefundProps } from '../domain/refund';
import { PaymentService } from './payment.service';
import { GatewayRefundRejectedError, PaymentGatewayPort, PaymentRepository, RefundFilter, RefundRepository } from './ports';

export interface RequestRefundInput {
  tenantId: string;
  orderId: string;
  returnId: string;
  amount: string;
  /** Resolución de la devolución: dinero de vuelta o saldo a favor. */
  resolution: 'refund_original' | 'store_credit';
  reason: string;
  /** Quien inspeccionó la devolución: no puede aprobar el reembolso. */
  requestedBy: string | null;
}

export type RefundView = RefundProps & {
  paymentMethod: PaymentMethod;
  requiredApprovals: number;
  pendingParts: RefundPart[];
};

export interface ApproveRefundResult {
  refund: RefundView;
  outcome: ApprovalOutcome;
  /** Con la aprobación completa: qué partes debe ejecutar cada quien (ver RefundPlan). */
  plan: RefundPlan | null;
}

const RETRY_BATCH = 20;

/**
 * Reembolsos: solicitud (al inspeccionar una devolución), aprobación simple o doble según el
 * monto, y ejecución por partes. La parte externa (reverso en la pasarela o transferencia) la
 * ejecuta Pagos; las partes internas (gift cards) las ejecuta el orquestador de posventa con
 * Promociones y las informa con completePart. Cuando se completan todas: succeeded, el pago pasa a
 * partially_refunded / refunded y sale RefundSucceeded (Pedidos, Facturación).
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly db: Database,
    private readonly refunds: RefundRepository,
    private readonly payments: PaymentRepository,
    private readonly paymentService: PaymentService,
    private readonly gateway: PaymentGatewayPort,
    private readonly outbox: OutboxWriter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Idempotente por devolución: un reintento devuelve el reembolso existente. */
  request(input: RequestRefundInput, now = new Date()): Promise<RefundView> {
    return this.db.withTransaction(async (tx) => {
      const existing = await this.refunds.findByReturn(tx, input.tenantId, input.returnId);
      if (existing) return this.view(tx, existing);
      const payment = this.refundablePayment(await this.payments.findByOrder(tx, input.tenantId, input.orderId, { forUpdate: true }), input.orderId);
      const refund = Refund.request(
        {
          tenantId: input.tenantId,
          paymentId: payment.id,
          orderId: input.orderId,
          returnId: input.returnId,
          amount: input.amount,
          method: refundMethodFor(input.resolution, payment.method),
          reason: input.reason,
          requestedBy: input.requestedBy,
        },
        now,
      );
      // Savepoint: un reembolso creado por otro proceso para la misma devolución no aborta la transacción.
      const inserted = await this.db.withTransaction((sp) => this.refunds.insert(sp, refund));
      if (!inserted) {
        const winner = await this.refunds.findByReturn(tx, input.tenantId, input.returnId);
        if (!winner) throw new Error(`Reembolso de la devolución ${input.returnId} no encontrado tras conflicto`);
        return this.view(tx, winner);
      }
      const r = refund.toJSON();
      await this.outbox.append(tx, [
        refundEvent(input.tenantId, REFUND_REQUESTED, {
          refundId: r.id,
          paymentId: r.paymentId,
          orderId: r.orderId,
          returnId: r.returnId,
          amount: r.amount,
          method: r.method,
          requiredApprovals: refund.requiredApprovals(this.threshold),
        }),
      ]);
      return this.view(tx, refund);
    });
  }

  /**
   * Aprobación de approverId. Con la aprobación completa fija el plan y pasa a processing, en la
   * misma transacción que el llamador (el orquestador ejecuta ahí las partes internas).
   */
  approve(tenantId: string, refundId: string, approverId: string, now = new Date()): Promise<ApproveRefundResult> {
    return this.db.withTransaction(async (tx) => {
      const refund = await this.lock(tx, tenantId, refundId);
      const payment = await this.payments.findById(tx, tenantId, refund.toJSON().paymentId, { forUpdate: true });
      if (!payment) throw new PaymentNotFoundError({ paymentId: refund.toJSON().paymentId });
      const outcome = refund.approve(approverId, this.threshold, now);
      let plan: RefundPlan | null = null;
      if (outcome === 'approved') {
        const others = (await this.refunds.listByPayment(tx, payment.id)).filter(
          (r) => r.id !== refund.id && (r.status === 'processing' || r.status === 'succeeded'),
        );
        plan = refund.planFor({
          paymentMethod: payment.method,
          paymentAmount: payment.amount,
          externalRefundedCents: others.reduce((s, r) => s + r.externalCents(), 0),
        });
        refund.startProcessing(plan);
      }
      await this.refunds.save(tx, refund);
      return { refund: await this.view(tx, refund), outcome, plan };
    });
  }

  /**
   * Una parte del plan se ejecutó (reference: referencia de la pasarela, de la transferencia o de la
   * gift card). Si era la última, cierra el reembolso. Idempotente por parte.
   */
  completePart(tenantId: string, refundId: string, part: RefundPart, reference: string, now = new Date()): Promise<RefundView> {
    return this.db.withTransaction(async (tx) => {
      const refund = await this.lock(tx, tenantId, refundId);
      const { changed, completed } = refund.completePart(part, reference, now);
      if (!changed) return this.view(tx, refund);
      await this.refunds.save(tx, refund);
      if (completed) await this.finish(tx, refund);
      return this.view(tx, refund);
    });
  }

  /** Finanzas registra la transferencia hecha al cliente (parte externa de un reembolso por transferencia). */
  async completeTransfer(tenantId: string, refundId: string, input: { bankName: string; reference: string }): Promise<RefundView> {
    const refund = await this.load(this.db, tenantId, refundId);
    if (refund.plan?.external?.kind !== 'transfer') {
      throw new InvalidRefundError('NOT_A_TRANSFER_REFUND', 'El reembolso no se paga por transferencia (o todavía no está aprobado)', {
        refundId,
      });
    }
    return this.completePart(tenantId, refundId, 'external', `${input.bankName.trim()} ${input.reference.trim()}`);
  }

  /**
   * Reverso en la pasarela (FUERA de una transacción: es I/O). Si la pasarela lo rechaza, el
   * reembolso queda failed; si no responde, sigue en processing y lo reintenta el job.
   */
  async executeGateway(tenantId: string, refundId: string): Promise<RefundView> {
    const refund = await this.load(this.db, tenantId, refundId);
    const plan = refund.plan;
    if (refund.status !== 'processing' || plan?.external?.kind !== 'gateway' || !refund.pendingParts().includes('external')) {
      return this.view(this.db, refund);
    }
    const r = refund.toJSON();
    const payment = await this.payments.findById(this.db, tenantId, r.paymentId);
    if (!payment?.toJSON().providerRef) throw new PaymentNotFoundError({ paymentId: r.paymentId, providerRef: null });
    try {
      const result = await this.gateway.refund({
        refundId: r.id,
        paymentId: r.paymentId,
        providerRef: payment.toJSON().providerRef!,
        amount: plan.external.amount,
        currency: payment.toJSON().currency,
      });
      return await this.completePart(tenantId, refundId, 'external', result.providerRef);
    } catch (error) {
      if (error instanceof GatewayRefundRejectedError) return this.fail(tenantId, refundId, `${error.code}: ${error.message}`);
      this.logger.warn(`Reverso del reembolso ${refundId} sin respuesta de la pasarela; se reintentará: ${error instanceof Error ? error.message : error}`);
      return this.view(this.db, refund);
    }
  }

  /** Job: reintenta los reversos pendientes en la pasarela. */
  async retryGatewayRefunds(): Promise<{ attempted: number }> {
    const pending = await this.refunds.listPendingGateway(this.db, RETRY_BATCH);
    for (const r of pending) await this.executeGateway(r.toJSON().tenantId, r.id);
    return { attempted: pending.length };
  }

  async get(tenantId: string, refundId: string): Promise<RefundView> {
    return this.view(this.db, await this.load(this.db, tenantId, refundId));
  }

  async findByReturn(tenantId: string, returnId: string): Promise<RefundView | null> {
    const refund = await this.refunds.findByReturn(this.db, tenantId, returnId);
    return refund ? this.view(this.db, refund) : null;
  }

  async list(tenantId: string, filter: RefundFilter): Promise<RefundView[]> {
    const limit = Math.min(Math.max(filter.limit, 1), 100);
    const refunds = await this.refunds.list(this.db, tenantId, { ...filter, limit });
    return Promise.all(refunds.map((r) => this.view(this.db, r)));
  }

  private fail(tenantId: string, refundId: string, reason: string): Promise<RefundView> {
    return this.db.withTransaction(async (tx) => {
      const refund = await this.lock(tx, tenantId, refundId);
      if (refund.fail(reason)) {
        await this.refunds.save(tx, refund);
        const r = refund.toJSON();
        await this.outbox.append(tx, [
          refundEvent(tenantId, REFUND_FAILED, { refundId: r.id, paymentId: r.paymentId, orderId: r.orderId, returnId: r.returnId, amount: r.amount, reason }),
        ]);
        this.logger.error(`Reembolso ${refundId} rechazado por la pasarela: ${reason}`);
      }
      return this.view(tx, refund);
    });
  }

  /** Reembolso completo: estado del pago y RefundSucceeded, en la transacción de la última parte. */
  private async finish(tx: Queryable, refund: Refund): Promise<void> {
    const r = refund.toJSON();
    const payment = await this.payments.findById(tx, r.tenantId, r.paymentId, { forUpdate: true });
    if (!payment) throw new PaymentNotFoundError({ paymentId: r.paymentId });
    const succeeded = (await this.refunds.listByPayment(tx, payment.id)).filter((x) => x.status === 'succeeded');
    // Lo devuelto a gift cards no sale de este pago, salvo que el pago haya sido con gift card.
    const refundedFromPayment = succeeded.reduce(
      (s, x) => s + (payment.method === 'gift_card' ? toCents(x.toJSON().amount) : x.externalCents()),
      0,
    );
    await this.paymentService.apply(tx, payment, payment.recordRefund(refundedFromPayment));
    await this.outbox.append(tx, [
      refundEvent(r.tenantId, REFUND_SUCCEEDED, {
        refundId: r.id,
        paymentId: r.paymentId,
        orderId: r.orderId,
        returnId: r.returnId,
        amount: r.amount,
        method: r.method,
        orderRefundedTotal: await this.refunds.succeededTotalForOrder(tx, r.tenantId, r.orderId),
        completedAt: r.completedAt!.toISOString(),
      }),
    ]);
  }

  /** El pago cobrado del pedido (el de mayor monto si hubiera varios). */
  private refundablePayment(payments: Payment[], orderId: string): Payment {
    const captured = payments
      .filter((p) => ['captured', 'partially_refunded'].includes(p.status))
      .sort((a, b) => toCents(b.amount) - toCents(a.amount));
    if (!captured[0]) {
      throw new RefundNotPossibleError('NO_CAPTURED_PAYMENT', 'El pedido no tiene un pago cobrado que se pueda reembolsar', { orderId });
    }
    return captured[0];
  }

  private get threshold(): number {
    return this.config.payments.refundDualApprovalAboveCents;
  }

  private async lock(tx: Queryable, tenantId: string, refundId: string): Promise<Refund> {
    const refund = await this.refunds.findById(tx, tenantId, refundId, { forUpdate: true });
    if (!refund) throw new RefundNotFoundError({ refundId });
    return refund;
  }

  private async load(q: Queryable, tenantId: string, refundId: string): Promise<Refund> {
    const refund = await this.refunds.findById(q, tenantId, refundId);
    if (!refund) throw new RefundNotFoundError({ refundId });
    return refund;
  }

  private async view(q: Queryable, refund: Refund): Promise<RefundView> {
    const r = refund.toJSON();
    const payment = await this.payments.findById(q, r.tenantId, r.paymentId);
    return {
      ...r,
      paymentMethod: payment?.method ?? 'card',
      requiredApprovals: refund.requiredApprovals(this.threshold),
      pendingParts: refund.pendingParts(),
    };
  }
}
