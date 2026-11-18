import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { BankTransfer, LockOption, PaymentEventEntry, PaymentFilter, PaymentRepository, TransferReconciliation } from '../application/ports';
import { Payment, PaymentEventRecord, PaymentMethod, PaymentProvider, PaymentStatus } from '../domain/payment';

const COLUMNS = `id, tenant_id, order_id, method, provider, amount, currency, status, provider_ref, authorization_code,
  card_brand, card_last4, idempotency_key, failure_code, failure_message, expires_at, captured_at, created_at, updated_at`;

interface PaymentRow {
  id: string;
  tenant_id: string;
  order_id: string;
  method: PaymentMethod;
  provider: PaymentProvider;
  amount: string;
  currency: string;
  status: PaymentStatus;
  provider_ref: string | null;
  authorization_code: string | null;
  card_brand: string | null;
  card_last4: string | null;
  idempotency_key: string;
  failure_code: string | null;
  failure_message: string | null;
  expires_at: Date | null;
  captured_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toPayment(r: PaymentRow): Payment {
  return Payment.restore({
    id: r.id,
    tenantId: r.tenant_id,
    orderId: r.order_id,
    method: r.method,
    provider: r.provider,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    providerRef: r.provider_ref,
    authorizationCode: r.authorization_code,
    cardBrand: r.card_brand,
    cardLast4: r.card_last4,
    idempotencyKey: r.idempotency_key,
    failureCode: r.failure_code,
    failureMessage: r.failure_message,
    expiresAt: r.expires_at,
    capturedAt: r.captured_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

const lock = (opts?: LockOption) => (opts?.forUpdate ? 'FOR UPDATE' : '');

@Injectable()
export class PgPaymentRepository extends PaymentRepository {
  async insert(q: Queryable, payment: Payment): Promise<boolean> {
    const p = payment.toJSON();
    const res = await q.query(
      `INSERT INTO payments.payments
         (id, tenant_id, order_id, method, provider, amount, currency, status, provider_ref, idempotency_key,
          expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
      [p.id, p.tenantId, p.orderId, p.method, p.provider, p.amount, p.currency, p.status, p.providerRef, p.idempotencyKey, p.expiresAt, p.createdAt],
    );
    return res.rowCount === 1;
  }

  async update(q: Queryable, payment: Payment): Promise<void> {
    const p = payment.toJSON();
    await q.query(
      `UPDATE payments.payments
          SET status = $2, provider_ref = $3, authorization_code = $4, card_brand = $5, card_last4 = $6,
              failure_code = $7, failure_message = $8, captured_at = $9, updated_at = $10
        WHERE id = $1`,
      [p.id, p.status, p.providerRef, p.authorizationCode, p.cardBrand, p.cardLast4, p.failureCode, p.failureMessage, p.capturedAt, p.updatedAt],
    );
  }

  async findById(q: Queryable, tenantId: string, id: string, opts?: LockOption): Promise<Payment | null> {
    const { rows } = await q.query<PaymentRow>(
      `SELECT ${COLUMNS} FROM payments.payments WHERE tenant_id = $1 AND id = $2 ${lock(opts)}`,
      [tenantId, id],
    );
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async findByIdempotencyKey(q: Queryable, tenantId: string, key: string): Promise<Payment | null> {
    const { rows } = await q.query<PaymentRow>(
      `SELECT ${COLUMNS} FROM payments.payments WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, key],
    );
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async findByProviderRef(q: Queryable, provider: string, providerRef: string, opts?: LockOption): Promise<Payment | null> {
    const { rows } = await q.query<PaymentRow>(
      `SELECT ${COLUMNS} FROM payments.payments WHERE provider = $1 AND provider_ref = $2 ${lock(opts)}`,
      [provider, providerRef],
    );
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async findByOrder(q: Queryable, tenantId: string, orderId: string, opts?: LockOption): Promise<Payment[]> {
    const { rows } = await q.query<PaymentRow>(
      `SELECT ${COLUMNS} FROM payments.payments WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id ${lock(opts)}`,
      [tenantId, orderId],
    );
    return rows.map(toPayment);
  }

  async list(q: Queryable, tenantId: string, f: PaymentFilter): Promise<Payment[]> {
    const where = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (f.statuses?.length) where.push(`status = ANY($${values.push(f.statuses)}::text[])`);
    if (f.method) where.push(`method = $${values.push(f.method)}`);
    if (f.orderId) where.push(`order_id = $${values.push(f.orderId)}`);
    const { rows } = await q.query<PaymentRow>(
      `SELECT ${COLUMNS} FROM payments.payments WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id LIMIT $${values.push(f.limit)} OFFSET $${values.push(f.offset)}`,
      values,
    );
    return rows.map(toPayment);
  }

  async listTransferReconciliation(q: Queryable, paymentIds: string[]): Promise<Map<string, TransferReconciliation>> {
    if (paymentIds.length === 0) return new Map();
    // ix_pe_payment (payment_id, created_at) para los dos eventos de cada pago.
    const { rows } = await q.query<{
      id: string;
      bank_name: string | null;
      reference: string | null;
      verified_by: string | null;
      verified_at: Date | null;
      rejection_reason: string | null;
      order_number: string | null;
      voucher_submitted_at: Date | null;
    }>(
      `SELECT p.id, bt.bank_name, bt.reference, bt.verified_by, bt.verified_at, bt.rejection_reason,
              (SELECT e.payload->>'orderNumber' FROM payments.payment_events e
                WHERE e.payment_id = p.id AND e.event_type = 'created' ORDER BY e.created_at LIMIT 1) AS order_number,
              (SELECT max(e.created_at) FROM payments.payment_events e
                WHERE e.payment_id = p.id AND e.event_type = 'voucher_submitted') AS voucher_submitted_at
         FROM payments.payments p
         LEFT JOIN payments.bank_transfers bt ON bt.payment_id = p.id
        WHERE p.id = ANY($1::uuid[]) AND p.method = 'transfer'`,
      [paymentIds],
    );
    return new Map(
      rows.map((r) => [
        r.id,
        {
          bankName: r.bank_name,
          reference: r.reference,
          orderNumber: r.order_number,
          voucherSubmittedAt: r.voucher_submitted_at,
          verifiedBy: r.verified_by,
          verifiedAt: r.verified_at,
          rejectionReason: r.rejection_reason,
        },
      ]),
    );
  }

  async claimExpired(q: Queryable, limit: number): Promise<Payment[]> {
    // ix_pay_pending (status, expires_at) WHERE status IN ('pending','requires_action')
    const { rows } = await q.query<PaymentRow>(
      `SELECT ${COLUMNS} FROM payments.payments
        WHERE status IN ('pending', 'requires_action') AND expires_at <= now()
        ORDER BY expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows.map(toPayment);
  }

  async insertEvent(q: Queryable, paymentId: string, record: PaymentEventRecord): Promise<void> {
    await q.query(`INSERT INTO payments.payment_events (payment_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
      paymentId,
      record.eventType,
      JSON.stringify(record.payload),
    ]);
  }

  async listEvents(q: Queryable, paymentId: string): Promise<PaymentEventEntry[]> {
    const { rows } = await q.query<{ id: string; event_type: string; payload: Record<string, unknown>; created_at: Date }>(
      `SELECT id, event_type, payload, created_at FROM payments.payment_events WHERE payment_id = $1 ORDER BY created_at, id`,
      [paymentId],
    );
    return rows.map((r) => ({ id: String(r.id), eventType: r.event_type, payload: r.payload, createdAt: r.created_at }));
  }

  async upsertBankTransfer(
    q: Queryable,
    t: { paymentId: string; bankName: string; reference: string | null; voucherKey: string },
  ): Promise<void> {
    await q.query(
      `INSERT INTO payments.bank_transfers (payment_id, bank_name, reference, voucher_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (payment_id) DO UPDATE
         SET bank_name = EXCLUDED.bank_name, reference = EXCLUDED.reference, voucher_key = EXCLUDED.voucher_key,
             verified_by = NULL, verified_at = NULL, rejection_reason = NULL`,
      [t.paymentId, t.bankName, t.reference, t.voucherKey],
    );
  }

  async findBankTransfer(q: Queryable, paymentId: string): Promise<BankTransfer | null> {
    const { rows } = await q.query<{
      payment_id: string;
      bank_name: string;
      reference: string | null;
      voucher_key: string | null;
      verified_by: string | null;
      verified_at: Date | null;
      rejection_reason: string | null;
    }>(`SELECT * FROM payments.bank_transfers WHERE payment_id = $1`, [paymentId]);
    const r = rows[0];
    if (!r) return null;
    return {
      paymentId: r.payment_id,
      bankName: r.bank_name,
      reference: r.reference,
      voucherKey: r.voucher_key,
      verifiedBy: r.verified_by,
      verifiedAt: r.verified_at,
      rejectionReason: r.rejection_reason,
    };
  }

  async reviewBankTransfer(q: Queryable, paymentId: string, reviewerId: string, rejectionReason: string | null): Promise<void> {
    await q.query(
      `UPDATE payments.bank_transfers SET verified_by = $2, verified_at = now(), rejection_reason = $3 WHERE payment_id = $1`,
      [paymentId, reviewerId, rejectionReason],
    );
  }
}
