import { Injectable } from '@nestjs/common';
import { isUniqueViolation, Queryable } from '../../../shared-kernel';
import { CustomerProfile, ReferralRepository } from '../application/ports';
import { Referral, ReferralStatus } from '../domain/referral';

interface ReferralRow {
  id: string;
  tenant_id: string;
  referrer_id: string;
  referee_id: string;
  status: ReferralStatus;
  qualifying_order: string | null;
  rewarded_at: Date | null;
  created_at: Date;
}

const COLUMNS = 'id, tenant_id, referrer_id, referee_id, status, qualifying_order, rewarded_at, created_at';

const toReferral = (r: ReferralRow): Referral => ({
  id: r.id,
  tenantId: r.tenant_id,
  referrerId: r.referrer_id,
  refereeId: r.referee_id,
  status: r.status,
  qualifyingOrder: r.qualifying_order,
  rewardedAt: r.rewarded_at,
  createdAt: r.created_at,
});

@Injectable()
export class PgReferralRepository extends ReferralRepository {
  async findProfile(q: Queryable, tenantId: string, userId: string): Promise<CustomerProfile | null> {
    const { rows } = await q.query<{ user_id: string; tenant_id: string; referral_code: string | null }>(
      `SELECT user_id, tenant_id, referral_code FROM crm.customer_profiles WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    return rows[0] ? { userId: rows[0].user_id, tenantId: rows[0].tenant_id, referralCode: rows[0].referral_code } : null;
  }

  async setReferralCode(q: Queryable, tenantId: string, userId: string, code: string): Promise<boolean> {
    try {
      // Si el perfil ya tenía código, no se cambia (true: hay código; el llamador lo relee).
      await q.query(
        `INSERT INTO crm.customer_profiles (user_id, tenant_id, referral_code) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET referral_code = COALESCE(crm.customer_profiles.referral_code, EXCLUDED.referral_code)`,
        [userId, tenantId, code],
      );
      return true;
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  }

  async findProfileByCode(q: Queryable, tenantId: string, code: string): Promise<CustomerProfile | null> {
    const { rows } = await q.query<{ user_id: string; tenant_id: string; referral_code: string }>(
      `SELECT user_id, tenant_id, referral_code FROM crm.customer_profiles WHERE tenant_id = $1 AND referral_code = $2`,
      [tenantId, code],
    );
    return rows[0] ? { userId: rows[0].user_id, tenantId: rows[0].tenant_id, referralCode: rows[0].referral_code } : null;
  }

  async insert(q: Queryable, r: Referral): Promise<boolean> {
    const res = await q.query(
      `INSERT INTO crm.referrals (id, tenant_id, referrer_id, referee_id, status, qualifying_order, rewarded_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (referee_id) DO NOTHING`,
      [r.id, r.tenantId, r.referrerId, r.refereeId, r.status, r.qualifyingOrder, r.rewardedAt, r.createdAt],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async findByReferee(q: Queryable, tenantId: string, refereeId: string, opts: { forUpdate?: boolean } = {}): Promise<Referral | null> {
    const { rows } = await q.query<ReferralRow>(
      `SELECT ${COLUMNS} FROM crm.referrals WHERE tenant_id = $1 AND referee_id = $2${opts.forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, refereeId],
    );
    return rows[0] ? toReferral(rows[0]) : null;
  }

  async findById(q: Queryable, tenantId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<Referral | null> {
    const { rows } = await q.query<ReferralRow>(`SELECT ${COLUMNS} FROM crm.referrals WHERE tenant_id = $1 AND id = $2${opts.forUpdate ? ' FOR UPDATE' : ''}`, [
      tenantId,
      id,
    ]);
    return rows[0] ? toReferral(rows[0]) : null;
  }

  async update(q: Queryable, r: Referral): Promise<void> {
    await q.query(`UPDATE crm.referrals SET status = $3, qualifying_order = $4, rewarded_at = $5 WHERE tenant_id = $1 AND id = $2`, [
      r.tenantId,
      r.id,
      r.status,
      r.qualifyingOrder,
      r.rewardedAt,
    ]);
  }

  async listByReferrer(q: Queryable, tenantId: string, referrerId: string): Promise<Referral[]> {
    const { rows } = await q.query<ReferralRow>(`SELECT ${COLUMNS} FROM crm.referrals WHERE tenant_id = $1 AND referrer_id = $2 ORDER BY created_at DESC`, [
      tenantId,
      referrerId,
    ]);
    return rows.map(toReferral);
  }

  async listQualified(q: Queryable, after: string | null, limit: number, tenantId: string | null = null): Promise<Referral[]> {
    const values: unknown[] = [limit];
    const where = [`status = 'qualified'`];
    if (after) where.push(`id > $${values.push(after)}::uuid`);
    if (tenantId) where.push(`tenant_id = $${values.push(tenantId)}`);
    const { rows } = await q.query<ReferralRow>(`SELECT ${COLUMNS} FROM crm.referrals WHERE ${where.join(' AND ')} ORDER BY id LIMIT $1`, values);
    return rows.map(toReferral);
  }
}
