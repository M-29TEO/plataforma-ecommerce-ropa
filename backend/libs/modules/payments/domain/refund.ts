import { randomUUID } from 'node:crypto';
import { fromCents, toCents } from '../../../shared-kernel';
import { InvalidRefundError, InvalidRefundTransitionError, RefundApprovalError } from './errors';
import { ONLINE_METHODS, PaymentMethod } from './payment';

/**
 * Reembolso (payments.refunds). Métodos:
 *  - original: al medio con que se pagó (reverso en la pasarela; si fue gift card, a esa tarjeta).
 *  - transfer: transferencia bancaria (pagos en efectivo contra entrega o por transferencia).
 *  - gift_card: saldo a favor en una gift card nueva.
 * ('store_credit' existe en el CHECK de la tabla; el proyecto usa gift_card para el saldo a favor.)
 *
 *   pending ──aprobación(es)──▶ processing ──todas las partes──▶ succeeded
 *                                   └──la pasarela lo rechaza──▶ failed
 *
 * Por encima del umbral (REFUND_DUAL_APPROVAL_ABOVE, $100) hacen falta DOS aprobaciones de
 * personas distintas; nunca aprueba quien lo solicitó. Las aprobaciones, el plan y las partes
 * ejecutadas quedan en la bitácora del pago (payments.payment_events).
 */
export const REFUND_METHODS = ['original', 'transfer', 'store_credit', 'gift_card'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];
export type RefundStatus = 'pending' | 'processing' | 'succeeded' | 'failed';
export type RefundPart = 'external' | 'gift_cards' | 'store_credit';

export interface RefundApproval {
  userId: string;
  at: Date;
}

/** Cómo se devuelve el dinero; se fija con la aprobación final. Montos "12.34". */
export interface RefundPlan {
  /** Parte que sale por la pasarela (reverso) o por transferencia manual. */
  external: { kind: 'gateway' | 'transfer'; amount: string } | null;
  /** Parte que vuelve a las gift cards con que se pagó el pedido. */
  giftCards: string;
  /** Saldo a favor en una gift card nueva. */
  storeCredit: string;
}

export interface CompletedPart {
  part: RefundPart;
  reference: string;
  at: Date;
}

export interface RefundProps {
  id: string;
  tenantId: string;
  paymentId: string;
  orderId: string;
  returnId: string | null;
  amount: string;
  method: RefundMethod;
  status: RefundStatus;
  providerRef: string | null;
  reason: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  createdAt: Date;
  completedAt: Date | null;
  approvals: RefundApproval[];
  plan: RefundPlan | null;
  completedParts: CompletedPart[];
  failureReason: string | null;
}

export interface NewRefund {
  tenantId: string;
  paymentId: string;
  orderId: string;
  returnId: string | null;
  amount: string;
  method: RefundMethod;
  reason: string | null;
  requestedBy: string | null;
}

/** Lo que el plan necesita saber del pago. */
export interface PlanContext {
  paymentMethod: PaymentMethod;
  paymentAmount: string;
  /** Lo que ya salió por la pasarela o por transferencia en otros reembolsos de este pago. */
  externalRefundedCents: number;
}

export type ApprovalOutcome = 'first_approval' | 'approved';

/**
 * Método según la resolución de la devolución y cómo se pagó: saldo a favor → gift card; dinero
 * de vuelta → el medio original si se puede revertir (pasarela o gift card); si se pagó en
 * efectivo o por transferencia, por transferencia bancaria.
 */
export function refundMethodFor(resolution: 'refund_original' | 'store_credit', paymentMethod: PaymentMethod): RefundMethod {
  if (resolution === 'store_credit') return 'gift_card';
  return ONLINE_METHODS.includes(paymentMethod) || paymentMethod === 'gift_card' ? 'original' : 'transfer';
}

export class Refund {
  private constructor(private props: RefundProps) {}

  static request(input: NewRefund, now = new Date()): Refund {
    const cents = toCents(input.amount);
    if (cents <= 0) throw new InvalidRefundError('INVALID_AMOUNT', 'El monto del reembolso debe ser mayor que 0');
    if (!(REFUND_METHODS as readonly string[]).includes(input.method)) {
      throw new InvalidRefundError('INVALID_REFUND_METHOD', 'Método de reembolso no soportado', { method: input.method });
    }
    return new Refund({
      id: randomUUID(),
      tenantId: input.tenantId,
      paymentId: input.paymentId,
      orderId: input.orderId,
      returnId: input.returnId,
      amount: fromCents(cents),
      method: input.method,
      status: 'pending',
      providerRef: null,
      reason: input.reason,
      requestedBy: input.requestedBy,
      approvedBy: null,
      createdAt: now,
      completedAt: null,
      approvals: [],
      plan: null,
      completedParts: [],
      failureReason: null,
    });
  }

  static restore(props: RefundProps): Refund {
    return new Refund({
      ...props,
      approvals: props.approvals.map((a) => ({ ...a })),
      plan: props.plan ? { ...props.plan, external: props.plan.external ? { ...props.plan.external } : null } : null,
      completedParts: props.completedParts.map((p) => ({ ...p })),
    });
  }

  get id(): string {
    return this.props.id;
  }
  get status(): RefundStatus {
    return this.props.status;
  }
  get plan(): RefundPlan | null {
    return this.props.plan;
  }

  toJSON(): RefundProps {
    return Refund.restore(this.props).props;
  }

  /** Cuántas aprobaciones exige el monto: 2 por encima del umbral (estrictamente mayor). */
  requiredApprovals(thresholdCents: number): 1 | 2 {
    return toCents(this.props.amount) > thresholdCents ? 2 : 1;
  }

  /**
   * Registra la aprobación de approverId. Devuelve 'first_approval' si todavía falta la segunda
   * (montos por encima del umbral) o 'approved' si ya está completa: entonces el llamador fija el
   * plan con startProcessing().
   */
  approve(approverId: string, thresholdCents: number, now = new Date()): ApprovalOutcome {
    if (this.props.status !== 'pending') throw new InvalidRefundTransitionError(this.props.id, this.props.status, 'processing');
    if (approverId === this.props.requestedBy) {
      throw new RefundApprovalError('REFUND_SELF_APPROVAL', 'Quien solicitó el reembolso no puede aprobarlo');
    }
    if (this.props.approvals.some((a) => a.userId === approverId)) {
      throw new RefundApprovalError('REFUND_SECOND_APPROVER_REQUIRED', 'La segunda aprobación debe hacerla otra persona', {
        approvedBy: this.props.approvals.map((a) => a.userId),
      });
    }
    this.props.approvals.push({ userId: approverId, at: now });
    if (this.props.approvals.length < this.requiredApprovals(thresholdCents)) return 'first_approval';
    this.props.approvedBy = approverId;
    return 'approved';
  }

  /** Plan de ejecución (ver RefundPlan). Solo tras la aprobación completa. */
  planFor(ctx: PlanContext): RefundPlan {
    const total = toCents(this.props.amount);
    if (this.props.method === 'gift_card' || this.props.method === 'store_credit') {
      return { external: null, giftCards: '0.00', storeCredit: fromCents(total) };
    }
    if (this.props.method === 'original' && ctx.paymentMethod === 'gift_card') {
      return { external: null, giftCards: fromCents(total), storeCredit: '0.00' };
    }
    const kind = this.props.method === 'original' ? 'gateway' : 'transfer';
    if (kind === 'gateway' && !ONLINE_METHODS.includes(ctx.paymentMethod)) {
      throw new InvalidRefundError('REFUND_METHOD_MISMATCH', 'Un pago que no fue en línea no se reversa por la pasarela', {
        paymentMethod: ctx.paymentMethod,
      });
    }
    // Lo que excede lo cobrado en este pago se pagó con gift card: vuelve a esas tarjetas.
    const refundable = Math.max(0, toCents(ctx.paymentAmount) - ctx.externalRefundedCents);
    const external = Math.min(total, refundable);
    return {
      external: external > 0 ? { kind, amount: fromCents(external) } : null,
      giftCards: fromCents(total - external),
      storeCredit: '0.00',
    };
  }

  startProcessing(plan: RefundPlan): void {
    if (this.props.status !== 'pending' || !this.props.approvedBy) {
      throw new InvalidRefundTransitionError(this.props.id, this.props.status, 'processing');
    }
    const sum = (plan.external ? toCents(plan.external.amount) : 0) + toCents(plan.giftCards) + toCents(plan.storeCredit);
    if (sum !== toCents(this.props.amount)) throw new Error(`El plan del reembolso ${this.props.id} no suma su monto`);
    this.props.plan = plan;
    this.props.status = 'processing';
  }

  /** Partes del plan que todavía no se ejecutaron. */
  pendingParts(): RefundPart[] {
    const plan = this.props.plan;
    if (!plan) return [];
    const parts: RefundPart[] = [];
    if (plan.external) parts.push('external');
    if (toCents(plan.giftCards) > 0) parts.push('gift_cards');
    if (toCents(plan.storeCredit) > 0) parts.push('store_credit');
    return parts.filter((p) => !this.props.completedParts.some((c) => c.part === p));
  }

  /**
   * Una parte del plan se ejecutó. Devuelve true si con ella se completó el reembolso (→ succeeded).
   * Repetir una parte ya registrada no hace nada (reintentos).
   */
  completePart(part: RefundPart, reference: string, now = new Date()): { changed: boolean; completed: boolean } {
    if (this.props.completedParts.some((c) => c.part === part)) return { changed: false, completed: false };
    if (this.props.status !== 'processing') throw new InvalidRefundTransitionError(this.props.id, this.props.status, 'succeeded');
    if (!this.pendingParts().includes(part)) {
      throw new InvalidRefundError('REFUND_PART_NOT_PLANNED', 'Esa parte no está en el plan del reembolso', { part });
    }
    this.props.completedParts.push({ part, reference, at: now });
    if (part === 'external' || !this.props.providerRef) this.props.providerRef = reference;
    if (this.pendingParts().length > 0) return { changed: true, completed: false };
    this.props.status = 'succeeded';
    this.props.completedAt = now;
    return { changed: true, completed: true };
  }

  /** La pasarela rechazó el reverso: requiere revisión manual. */
  fail(reason: string): boolean {
    if (this.props.status === 'failed') return false;
    if (this.props.status !== 'processing') throw new InvalidRefundTransitionError(this.props.id, this.props.status, 'failed');
    this.props.status = 'failed';
    this.props.failureReason = reason;
    return true;
  }

  /** Lo que salió por la pasarela o por transferencia (cuenta para el estado del pago). */
  externalCents(): number {
    return this.props.plan?.external ? toCents(this.props.plan.external.amount) : 0;
  }
}
