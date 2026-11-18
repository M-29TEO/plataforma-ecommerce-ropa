import { Injectable } from '@nestjs/common';
import { fromCents, isUniqueViolation, Queryable, toCents } from '../../../shared-kernel';
import { LockOption, RefundFilter, RefundRepository } from '../application/ports';
import { CompletedPart, Refund, RefundApproval, RefundMethod, RefundPart, RefundPlan, RefundProps, RefundStatus } from '../domain/refund';

/** Índice único parcial de la migración 1759000000008: un reembolso por devolución. */
const ONE_PER_RETURN = 'ux_refunds_return';

const COLUMNS = `r.id, r.payment_id, r.return_id, r.amount, r.method, r.status, r.provider_ref, r.reason, r.requested_by,
  r.approved_by, r.created_at, r.completed_at, p.tenant_id, p.order_id`;
const FROM = 'payments.refunds r JOIN payments.payments p ON p.id = r.payment_id';

/** Tipos de payment_events que describen un reembolso (payload.refundId). */
const EV = {
  requested: 'refund_requested',
  approved: 'refund_approved',
  plan: 'refund_plan',
  part: 'refund_part_completed',
  succeeded: 'refund_succeeded',
  failed: 'refund_failed',
} as const;

interface RefundRow {
  id: string;
  payment_id: string;
  return_id: string | null;
  amount: string;
  method: RefundMethod;
  status: RefundStatus;
  provider_ref: string | null;
  reason: string | null;
  requested_by: string | null;
  approved_by: string | null;
  created_at: Date;
  completed_at: Date | null;
  tenant_id: string;
  order_id: string;
}

interface EventRow {
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

interface LogState {
  approvals: RefundApproval[];
  plan: RefundPlan | null;
  parts: CompletedPart[];
  failureReason: string | null;
  succeeded: boolean;
}

function readLog(events: EventRow[]): LogState {
  const state: LogState = { approvals: [], plan: null, parts: [], failureReason: null, succeeded: false };
  for (const e of events) {
    const p = e.payload;
    if (e.event_type === EV.approved) state.approvals.push({ userId: String(p.userId), at: e.created_at });
    else if (e.event_type === EV.plan) state.plan = p.plan as RefundPlan;
    else if (e.event_type === EV.part) state.parts.push({ part: p.part as RefundPart, reference: String(p.reference), at: e.created_at });
    else if (e.event_type === EV.failed) state.failureReason = String(p.reason);
    else if (e.event_type === EV.succeeded) state.succeeded = true;
  }
  return state;
}

@Injectable()
export class PgRefundRepository extends RefundRepository {
  async insert(q: Queryable, refund: Refund): Promise<boolean> {
    const r = refund.toJSON();
    try {
      await q.query(
        `INSERT INTO payments.refunds (id, payment_id, return_id, amount, method, status, reason, requested_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [r.id, r.paymentId, r.returnId, r.amount, r.method, r.status, r.reason, r.requestedBy, r.createdAt],
      );
    } catch (error) {
      if (isUniqueViolation(error, ONE_PER_RETURN)) return false;
      throw error;
    }
    await this.log(q, r.paymentId, EV.requested, { refundId: r.id, amount: r.amount, method: r.method, returnId: r.returnId, requestedBy: r.requestedBy });
    return true;
  }

  async save(q: Queryable, refund: Refund): Promise<void> {
    const r = refund.toJSON();
    await q.query(
      `UPDATE payments.refunds SET status = $2, provider_ref = $3, approved_by = $4, completed_at = $5 WHERE id = $1`,
      [r.id, r.status, r.providerRef, r.approvedBy, r.completedAt],
    );
    const logged = readLog(await this.events(q, [r.paymentId], [r.id]));
    for (const a of r.approvals) {
      if (!logged.approvals.some((l) => l.userId === a.userId)) {
        await this.log(q, r.paymentId, EV.approved, { refundId: r.id, userId: a.userId, step: r.approvals.indexOf(a) + 1 });
      }
    }
    if (r.plan && !logged.plan) await this.log(q, r.paymentId, EV.plan, { refundId: r.id, plan: r.plan });
    for (const part of r.completedParts) {
      if (!logged.parts.some((l) => l.part === part.part)) {
        await this.log(q, r.paymentId, EV.part, { refundId: r.id, part: part.part, reference: part.reference });
      }
    }
    if (r.failureReason && !logged.failureReason) await this.log(q, r.paymentId, EV.failed, { refundId: r.id, reason: r.failureReason });
    if (r.status === 'succeeded' && !logged.succeeded) await this.log(q, r.paymentId, EV.succeeded, { refundId: r.id, amount: r.amount });
  }

  async findById(q: Queryable, tenantId: string, id: string, opts?: LockOption): Promise<Refund | null> {
    const { rows } = await q.query<RefundRow>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE p.tenant_id = $1 AND r.id = $2 ${opts?.forUpdate ? 'FOR UPDATE OF r' : ''}`,
      [tenantId, id],
    );
    return (await this.hydrate(q, rows))[0] ?? null;
  }

  async findByReturn(q: Queryable, tenantId: string, returnId: string): Promise<Refund | null> {
    const { rows } = await q.query<RefundRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE p.tenant_id = $1 AND r.return_id = $2`, [tenantId, returnId]);
    return (await this.hydrate(q, rows))[0] ?? null;
  }

  async list(q: Queryable, tenantId: string, f: RefundFilter): Promise<Refund[]> {
    const where = ['p.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (f.statuses?.length) where.push(`r.status = ANY($${values.push(f.statuses)}::text[])`);
    if (f.orderId) where.push(`p.order_id = $${values.push(f.orderId)}`);
    if (f.returnId) where.push(`r.return_id = $${values.push(f.returnId)}`);
    const { rows } = await q.query<RefundRow>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC, r.id LIMIT $${values.push(f.limit)} OFFSET $${values.push(f.offset)}`,
      values,
    );
    return this.hydrate(q, rows);
  }

  async listByPayment(q: Queryable, paymentId: string): Promise<Refund[]> {
    const { rows } = await q.query<RefundRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE r.payment_id = $1 ORDER BY r.created_at`, [paymentId]);
    return this.hydrate(q, rows);
  }

  async succeededTotalForOrder(q: Queryable, tenantId: string, orderId: string): Promise<string> {
    const { rows } = await q.query<{ total: string }>(
      `SELECT COALESCE(sum(r.amount), 0)::numeric(12,2)::text AS total FROM ${FROM}
        WHERE p.tenant_id = $1 AND p.order_id = $2 AND r.status = 'succeeded'`,
      [tenantId, orderId],
    );
    return fromCents(toCents(rows[0].total));
  }

  async listPendingGateway(q: Queryable, limit: number): Promise<Refund[]> {
    const { rows } = await q.query<RefundRow>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE r.status = 'processing' AND r.method = 'original'
        ORDER BY r.created_at LIMIT $1`,
      [limit],
    );
    return (await this.hydrate(q, rows)).filter((r) => r.plan?.external?.kind === 'gateway' && r.pendingParts().includes('external'));
  }

  private async hydrate(q: Queryable, rows: RefundRow[]): Promise<Refund[]> {
    if (!rows.length) return [];
    const events = await this.events(
      q,
      [...new Set(rows.map((r) => r.payment_id))],
      rows.map((r) => r.id),
    );
    return rows.map((r) => {
      const log = readLog(events.filter((e) => e.payload.refundId === r.id));
      const props: RefundProps = {
        id: r.id,
        tenantId: r.tenant_id,
        paymentId: r.payment_id,
        orderId: r.order_id,
        returnId: r.return_id,
        amount: r.amount,
        method: r.method,
        status: r.status,
        providerRef: r.provider_ref,
        reason: r.reason,
        requestedBy: r.requested_by,
        approvedBy: r.approved_by,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        approvals: log.approvals,
        plan: log.plan,
        completedParts: log.parts,
        failureReason: log.failureReason,
      };
      return Refund.restore(props);
    });
  }

  private async events(q: Queryable, paymentIds: string[], refundIds: string[]): Promise<EventRow[]> {
    // ix_pe_payment (payment_id, created_at): pocas filas por pago; el filtro por refundId es en memoria del servidor.
    const { rows } = await q.query<EventRow>(
      `SELECT event_type, payload, created_at FROM payments.payment_events
        WHERE payment_id = ANY($1::uuid[]) AND event_type LIKE 'refund\\_%' AND payload->>'refundId' = ANY($2::text[])
        ORDER BY created_at, id`,
      [paymentIds, refundIds],
    );
    return rows;
  }

  private async log(q: Queryable, paymentId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    await q.query(`INSERT INTO payments.payment_events (payment_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
      paymentId,
      eventType,
      JSON.stringify(payload),
    ]);
  }
}
