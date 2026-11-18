import { Injectable } from '@nestjs/common';
import { buildSetClause, Queryable } from '../../../shared-kernel';
import { NewRedemption, PromotionFilter, PromotionPatch, PromotionRepository, Redemption } from '../application/ports';
import { CouponProps, PromotionProps } from '../domain/promotion';

const PROMOTION_COLUMNS = `p.id, p.tenant_id, p.name, p.type, p.conditions, p.benefit, p.requires_coupon, p.stackable,
  p.priority, p.max_uses, p.used_count, p.starts_at, p.ends_at, p.active, p.created_at`;

const COUPON_COLUMNS = `c.id AS coupon_id, c.promotion_id AS coupon_promotion_id, c.tenant_id AS coupon_tenant_id,
  c.code::text AS coupon_code, c.max_uses AS coupon_max_uses, c.max_uses_per_customer, c.used_count AS coupon_used_count,
  c.assigned_user_id`;

interface PromotionRow {
  id: string;
  tenant_id: string;
  name: string;
  type: PromotionProps['type'];
  conditions: PromotionProps['conditions'];
  benefit: PromotionProps['benefit'];
  requires_coupon: boolean;
  stackable: boolean;
  priority: number;
  max_uses: number | null;
  used_count: number;
  starts_at: Date;
  ends_at: Date | null;
  active: boolean;
  created_at: Date;
}

interface CouponRow {
  coupon_id: string;
  coupon_promotion_id: string;
  coupon_tenant_id: string;
  coupon_code: string;
  coupon_max_uses: number | null;
  max_uses_per_customer: number;
  coupon_used_count: number;
  assigned_user_id: string | null;
}

interface RedemptionRow {
  id: string;
  promotion_id: string;
  coupon_id: string | null;
  order_id: string;
  user_id: string | null;
  customer_key: string;
  discount: string;
  created_at: Date;
}

function toPromotion(r: PromotionRow): PromotionProps {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    type: r.type,
    conditions: r.conditions,
    benefit: r.benefit,
    requiresCoupon: r.requires_coupon,
    stackable: r.stackable,
    priority: r.priority,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    active: r.active,
    createdAt: r.created_at,
  };
}

function toCoupon(r: CouponRow): CouponProps {
  return {
    id: r.coupon_id,
    promotionId: r.coupon_promotion_id,
    tenantId: r.coupon_tenant_id,
    code: r.coupon_code,
    maxUses: r.coupon_max_uses,
    maxUsesPerCustomer: r.max_uses_per_customer,
    usedCount: r.coupon_used_count,
    assignedUserId: r.assigned_user_id,
  };
}

function toRedemption(r: RedemptionRow): Redemption {
  return {
    id: r.id,
    promotionId: r.promotion_id,
    couponId: r.coupon_id,
    orderId: r.order_id,
    userId: r.user_id,
    customerKey: r.customer_key,
    discount: r.discount,
    createdAt: r.created_at,
  };
}

const PATCH_COLUMNS: Record<keyof PromotionPatch, string> = {
  name: 'name',
  conditions: 'conditions',
  benefit: 'benefit',
  requiresCoupon: 'requires_coupon',
  stackable: 'stackable',
  priority: 'priority',
  maxUses: 'max_uses',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  active: 'active',
};

@Injectable()
export class PgPromotionRepository extends PromotionRepository {
  async insert(q: Queryable, p: PromotionProps): Promise<void> {
    await q.query(
      `INSERT INTO sales.promotions
         (id, tenant_id, name, type, conditions, benefit, requires_coupon, stackable, priority, max_uses,
          used_count, starts_at, ends_at, active, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        p.id,
        p.tenantId,
        p.name,
        p.type,
        JSON.stringify(p.conditions),
        JSON.stringify(p.benefit),
        p.requiresCoupon,
        p.stackable,
        p.priority,
        p.maxUses,
        p.usedCount,
        p.startsAt,
        p.endsAt,
        p.active,
        p.createdAt,
      ],
    );
  }

  async findById(q: Queryable, tenantId: string, id: string): Promise<PromotionProps | null> {
    const { rows } = await q.query<PromotionRow>(
      `SELECT ${PROMOTION_COLUMNS} FROM sales.promotions p WHERE p.tenant_id = $1 AND p.id = $2`,
      [tenantId, id],
    );
    return rows[0] ? toPromotion(rows[0]) : null;
  }

  async findRewardPromotion(q: Queryable, tenantId: string, name: string): Promise<PromotionProps | null> {
    const { rows } = await q.query<PromotionRow>(
      `SELECT ${PROMOTION_COLUMNS} FROM sales.promotions p
        WHERE p.tenant_id = $1 AND p.name = $2 AND p.requires_coupon AND p.type = 'fixed'
        ORDER BY p.created_at LIMIT 1`,
      [tenantId, name],
    );
    return rows[0] ? toPromotion(rows[0]) : null;
  }

  async list(q: Queryable, tenantId: string, f: PromotionFilter): Promise<PromotionProps[]> {
    const where = ['p.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (f.active !== undefined) where.push(`p.active = $${values.push(f.active)}`);
    if (f.type) where.push(`p.type = $${values.push(f.type)}`);
    const limit = values.push(f.limit);
    const offset = values.push(f.offset);
    const { rows } = await q.query<PromotionRow>(
      `SELECT ${PROMOTION_COLUMNS} FROM sales.promotions p
        WHERE ${where.join(' AND ')}
        ORDER BY p.created_at DESC, p.id
        LIMIT $${limit} OFFSET $${offset}`,
      values,
    );
    return rows.map(toPromotion);
  }

  async update(q: Queryable, tenantId: string, id: string, patch: PromotionPatch): Promise<PromotionProps | null> {
    // buildSetClause serializa objetos como JSON: las fechas van antes como texto ISO.
    const iso = (d: Date | null | undefined) => (d instanceof Date ? d.toISOString() : d);
    const { sql, values } = buildSetClause(
      { ...patch, startsAt: iso(patch.startsAt), endsAt: iso(patch.endsAt) },
      PATCH_COLUMNS,
      3,
    );
    if (!sql) return this.findById(q, tenantId, id);
    const { rows } = await q.query<PromotionRow>(
      `UPDATE sales.promotions p SET ${sql} WHERE p.tenant_id = $1 AND p.id = $2 RETURNING ${PROMOTION_COLUMNS}`,
      [tenantId, id, ...values],
    );
    return rows[0] ? toPromotion(rows[0]) : null;
  }

  async findAutomatic(q: Queryable, tenantId: string, now: Date): Promise<PromotionProps[]> {
    const { rows } = await q.query<PromotionRow>(
      `SELECT ${PROMOTION_COLUMNS} FROM sales.promotions p
        WHERE p.tenant_id = $1 AND p.active AND NOT p.requires_coupon
          AND p.starts_at <= $2 AND (p.ends_at IS NULL OR p.ends_at > $2)
          AND (p.max_uses IS NULL OR p.used_count < p.max_uses)
        ORDER BY p.priority, p.created_at, p.id`,
      [tenantId, now],
    );
    return rows.map(toPromotion);
  }

  async insertCoupon(q: Queryable, c: CouponProps): Promise<void> {
    await q.query(
      `INSERT INTO sales.coupons (id, promotion_id, tenant_id, code, max_uses, max_uses_per_customer, used_count, assigned_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [c.id, c.promotionId, c.tenantId, c.code, c.maxUses, c.maxUsesPerCustomer, c.usedCount, c.assignedUserId],
    );
  }

  async listCoupons(q: Queryable, tenantId: string, promotionId: string): Promise<CouponProps[]> {
    const { rows } = await q.query<CouponRow>(
      `SELECT ${COUPON_COLUMNS} FROM sales.coupons c WHERE c.tenant_id = $1 AND c.promotion_id = $2 ORDER BY c.code`,
      [tenantId, promotionId],
    );
    return rows.map(toCoupon);
  }

  async findCouponsByCodes(q: Queryable, tenantId: string, codes: string[]) {
    const { rows } = await q.query<CouponRow & PromotionRow>(
      `SELECT ${COUPON_COLUMNS}, ${PROMOTION_COLUMNS}
         FROM sales.coupons c JOIN sales.promotions p ON p.id = c.promotion_id
        WHERE c.tenant_id = $1 AND c.code = ANY($2::citext[])`,
      [tenantId, codes],
    );
    return rows.map((r) => ({ coupon: toCoupon(r), promotion: toPromotion(r) }));
  }

  async countCustomerUses(
    q: Queryable,
    couponIds: string[],
    customerKeys: string[],
    userId: string | null,
    excludeOrderId?: string,
  ): Promise<Map<string, number>> {
    const { rows } = await q.query<{ coupon_id: string; uses: number }>(
      `SELECT coupon_id, count(*)::int AS uses
         FROM sales.promotion_redemptions
        WHERE coupon_id = ANY($1::uuid[])
          AND (customer_key = ANY($2::text[]) OR ($3::uuid IS NOT NULL AND user_id = $3::uuid))
          AND ($4::uuid IS NULL OR order_id <> $4::uuid)
        GROUP BY coupon_id`,
      [couponIds, customerKeys, userId, excludeOrderId ?? null],
    );
    return new Map(rows.map((r) => [r.coupon_id, r.uses]));
  }

  async takeCouponUse(q: Queryable, tenantId: string, couponId: string, promotionId: string): Promise<CouponProps | null> {
    const { rows } = await q.query<CouponRow>(
      `UPDATE sales.coupons c SET used_count = c.used_count + 1
        WHERE c.id = $1 AND c.tenant_id = $2 AND c.promotion_id = $3
          AND (c.max_uses IS NULL OR c.used_count < c.max_uses)
        RETURNING ${COUPON_COLUMNS}`,
      [couponId, tenantId, promotionId],
    );
    return rows[0] ? toCoupon(rows[0]) : null;
  }

  async takePromotionUse(q: Queryable, tenantId: string, promotionId: string): Promise<boolean> {
    const res = await q.query(
      `UPDATE sales.promotions SET used_count = used_count + 1
        WHERE id = $1 AND tenant_id = $2 AND active
          AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
          AND (max_uses IS NULL OR used_count < max_uses)`,
      [promotionId, tenantId],
    );
    return res.rowCount === 1;
  }

  async releaseCouponUse(q: Queryable, couponId: string): Promise<void> {
    await q.query(`UPDATE sales.coupons SET used_count = GREATEST(used_count - 1, 0) WHERE id = $1`, [couponId]);
  }

  async releasePromotionUse(q: Queryable, promotionId: string): Promise<void> {
    await q.query(`UPDATE sales.promotions SET used_count = GREATEST(used_count - 1, 0) WHERE id = $1`, [promotionId]);
  }

  async insertRedemptions(q: Queryable, rows: NewRedemption[]): Promise<void> {
    await q.query(
      `INSERT INTO sales.promotion_redemptions (promotion_id, coupon_id, order_id, user_id, customer_key, discount)
       SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::numeric[])`,
      [
        rows.map((r) => r.promotionId),
        rows.map((r) => r.couponId),
        rows.map((r) => r.orderId),
        rows.map((r) => r.userId),
        rows.map((r) => r.customerKey),
        rows.map((r) => r.discount),
      ],
    );
  }

  async findRedemptionsByOrder(
    q: Queryable,
    tenantId: string,
    orderId: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<Redemption[]> {
    const { rows } = await q.query<RedemptionRow>(
      `SELECT r.id::text, r.promotion_id, r.coupon_id, r.order_id, r.user_id, r.customer_key, r.discount, r.created_at
         FROM sales.promotion_redemptions r JOIN sales.promotions p ON p.id = r.promotion_id
        WHERE r.order_id = $1 AND p.tenant_id = $2
        ORDER BY r.id ${opts.forUpdate ? 'FOR UPDATE OF r' : ''}`,
      [orderId, tenantId],
    );
    return rows.map(toRedemption);
  }

  async deleteRedemptions(q: Queryable, ids: string[]): Promise<void> {
    await q.query(`DELETE FROM sales.promotion_redemptions WHERE id = ANY($1::bigint[])`, [ids]);
  }
}
