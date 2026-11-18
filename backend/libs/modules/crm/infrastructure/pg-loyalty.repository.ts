import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { DueOrder, LoyaltyRepository, NewLoyaltyTransaction } from '../application/ports';
import { LoyaltyAccount, LoyaltyTier, LoyaltyTransaction, LoyaltyTxStatus, LoyaltyTxType } from '../domain/loyalty';

interface TierRow {
  id: string;
  tenant_id: string;
  name: string;
  min_points: number;
  multiplier: string;
  benefits: Record<string, unknown>;
}

interface AccountRow {
  user_id: string;
  tenant_id: string;
  tier_id: string | null;
  points_balance: number;
  points_pending: number;
  lifetime_points: number;
  updated_at: Date;
}

interface TxRow {
  id: string;
  user_id: string;
  tenant_id: string;
  type: LoyaltyTxType;
  points: number;
  order_id: string | null;
  reference: string | null;
  status: LoyaltyTxStatus;
  available_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

const TIER_COLUMNS = 'id, tenant_id, name, min_points, multiplier::text AS multiplier, benefits';
const ACCOUNT_COLUMNS = 'user_id, tenant_id, tier_id, points_balance, points_pending, lifetime_points, updated_at';
const TX_COLUMNS = 'id::text, user_id, tenant_id, type, points, order_id, reference, status, available_at, expires_at, created_at';

const toTier = (r: TierRow): LoyaltyTier => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  minPoints: r.min_points,
  multiplier: r.multiplier,
  benefits: r.benefits,
});

const toAccount = (r: AccountRow): LoyaltyAccount => ({
  userId: r.user_id,
  tenantId: r.tenant_id,
  tierId: r.tier_id,
  pointsBalance: r.points_balance,
  pointsPending: r.points_pending,
  lifetimePoints: r.lifetime_points,
  updatedAt: r.updated_at,
});

const toTx = (r: TxRow): LoyaltyTransaction => ({
  id: r.id,
  userId: r.user_id,
  tenantId: r.tenant_id,
  type: r.type,
  points: r.points,
  orderId: r.order_id,
  reference: r.reference,
  status: r.status,
  availableAt: r.available_at,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

@Injectable()
export class PgLoyaltyRepository extends LoyaltyRepository {
  async listTiers(q: Queryable, tenantId: string): Promise<LoyaltyTier[]> {
    const { rows } = await q.query<TierRow>(`SELECT ${TIER_COLUMNS} FROM crm.loyalty_tiers WHERE tenant_id = $1 ORDER BY min_points`, [tenantId]);
    return rows.map(toTier);
  }

  async findTier(q: Queryable, tenantId: string, id: string): Promise<LoyaltyTier | null> {
    const { rows } = await q.query<TierRow>(`SELECT ${TIER_COLUMNS} FROM crm.loyalty_tiers WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return rows[0] ? toTier(rows[0]) : null;
  }

  async insertTier(q: Queryable, t: LoyaltyTier): Promise<void> {
    await q.query(`INSERT INTO crm.loyalty_tiers (id, tenant_id, name, min_points, multiplier, benefits) VALUES ($1, $2, $3, $4, $5, $6)`, [
      t.id,
      t.tenantId,
      t.name,
      t.minPoints,
      t.multiplier,
      JSON.stringify(t.benefits),
    ]);
  }

  async updateTier(q: Queryable, t: LoyaltyTier): Promise<void> {
    await q.query(`UPDATE crm.loyalty_tiers SET name = $3, min_points = $4, multiplier = $5, benefits = $6 WHERE tenant_id = $1 AND id = $2`, [
      t.tenantId,
      t.id,
      t.name,
      t.minPoints,
      t.multiplier,
      JSON.stringify(t.benefits),
    ]);
  }

  async deleteTier(q: Queryable, tenantId: string, id: string): Promise<boolean> {
    const r = await q.query(`DELETE FROM crm.loyalty_tiers WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async countAccountsInTier(q: Queryable, tierId: string): Promise<number> {
    const { rows } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm.loyalty_accounts WHERE tier_id = $1`, [tierId]);
    return rows[0].n;
  }

  async ensureAccount(q: Queryable, tenantId: string, userId: string, tierId: string | null): Promise<void> {
    await q.query(`INSERT INTO crm.loyalty_accounts (user_id, tenant_id, tier_id) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`, [userId, tenantId, tierId]);
  }

  async findAccount(q: Queryable, tenantId: string, userId: string, opts: { forUpdate?: boolean } = {}): Promise<LoyaltyAccount | null> {
    const { rows } = await q.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM crm.loyalty_accounts WHERE tenant_id = $1 AND user_id = $2${opts.forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, userId],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async saveAccount(q: Queryable, a: LoyaltyAccount): Promise<void> {
    const { rows } = await q.query<{ updated_at: Date }>(
      `UPDATE crm.loyalty_accounts SET tier_id = $3, points_balance = $4, points_pending = $5, lifetime_points = $6, updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 RETURNING updated_at`,
      [a.tenantId, a.userId, a.tierId, a.pointsBalance, a.pointsPending, a.lifetimePoints],
    );
    if (rows[0]) a.updatedAt = rows[0].updated_at;
  }

  async insertTransaction(q: Queryable, t: NewLoyaltyTransaction): Promise<LoyaltyTransaction | null> {
    const { rows } = await q.query<TxRow>(
      `INSERT INTO crm.loyalty_transactions (user_id, tenant_id, type, points, order_id, reference, status, available_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, type, reference) WHERE reference IS NOT NULL AND type <> 'adjust' DO NOTHING
       RETURNING ${TX_COLUMNS}`,
      [t.userId, t.tenantId, t.type, t.points, t.orderId, t.reference, t.status, t.availableAt, t.expiresAt],
    );
    return rows[0] ? toTx(rows[0]) : null;
  }

  async findByReference(q: Queryable, tenantId: string, type: LoyaltyTxType, reference: string): Promise<LoyaltyTransaction | null> {
    const { rows } = await q.query<TxRow>(`SELECT ${TX_COLUMNS} FROM crm.loyalty_transactions WHERE tenant_id = $1 AND type = $2 AND reference = $3`, [
      tenantId,
      type,
      reference,
    ]);
    return rows[0] ? toTx(rows[0]) : null;
  }

  async listOrderTransactions(q: Queryable, tenantId: string, orderId: string): Promise<LoyaltyTransaction[]> {
    const { rows } = await q.query<TxRow>(`SELECT ${TX_COLUMNS} FROM crm.loyalty_transactions WHERE tenant_id = $1 AND order_id = $2 ORDER BY id`, [
      tenantId,
      orderId,
    ]);
    return rows.map(toTx);
  }

  async setOrderStatus(q: Queryable, tenantId: string, orderId: string, from: LoyaltyTxStatus, to: LoyaltyTxStatus): Promise<void> {
    await q.query(`UPDATE crm.loyalty_transactions SET status = $4 WHERE tenant_id = $1 AND order_id = $2 AND status = $3`, [tenantId, orderId, from, to]);
  }

  async listTransactions(q: Queryable, tenantId: string, userId: string, limit: number, offset: number): Promise<LoyaltyTransaction[]> {
    const { rows } = await q.query<TxRow>(
      `SELECT ${TX_COLUMNS} FROM crm.loyalty_transactions WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [tenantId, userId, limit, offset],
    );
    return rows.map(toTx);
  }

  async listPending(q: Queryable, tenantId: string, userId: string): Promise<LoyaltyTransaction[]> {
    const { rows } = await q.query<TxRow>(
      `SELECT ${TX_COLUMNS} FROM crm.loyalty_transactions WHERE tenant_id = $1 AND user_id = $2 AND status = 'pending' ORDER BY available_at, id`,
      [tenantId, userId],
    );
    return rows.map(toTx);
  }

  async dueOrders(q: Queryable, now: Date, limit: number, tenantId: string | null = null): Promise<DueOrder[]> {
    const values: unknown[] = [now, limit];
    const tenantFilter = tenantId ? `AND tenant_id = $${values.push(tenantId)}` : '';
    const { rows } = await q.query<{ tenant_id: string; user_id: string; order_id: string }>(
      `SELECT tenant_id, user_id, order_id FROM crm.loyalty_transactions
        WHERE status = 'pending' AND type = 'earn' AND order_id IS NOT NULL AND available_at <= $1 ${tenantFilter}
        ORDER BY available_at, id LIMIT $2`,
      values,
    );
    return rows.map((r) => ({ tenantId: r.tenant_id, userId: r.user_id, orderId: r.order_id }));
  }

  async postpone(q: Queryable, tenantId: string, orderId: string, until: Date): Promise<void> {
    await q.query(`UPDATE crm.loyalty_transactions SET available_at = $3 WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending'`, [
      tenantId,
      orderId,
      until,
    ]);
  }
}
