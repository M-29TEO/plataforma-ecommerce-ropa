import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { AbandonmentCandidate, CartRepository, LockOption } from '../application/ports';
import { Cart, CartItem, CartProps } from '../domain/cart';

const COLUMNS = `c.id, c.tenant_id, c.user_id, c.guest_token_hash, c.contact_email::text AS contact_email, c.contact_phone,
  c.currency, c.coupon_codes, c.status, c.last_activity_at, c.created_at`;

interface CartRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  guest_token_hash: Buffer | null;
  contact_email: string | null;
  contact_phone: string | null;
  currency: string;
  coupon_codes: string[];
  status: CartProps['status'];
  last_activity_at: Date;
  created_at: Date;
}

interface ItemRow {
  variant_id: string;
  quantity: number;
  price_at_add: string;
  added_at: Date;
}

@Injectable()
export class PgCartRepository extends CartRepository {
  findActiveByUser(q: Queryable, tenantId: string, userId: string, opts: LockOption = {}): Promise<Cart | null> {
    return this.findOne(q, `c.tenant_id = $1 AND c.user_id = $2 AND c.status = 'active'`, [tenantId, userId], opts);
  }

  findActiveByGuestToken(q: Queryable, tenantId: string, tokenHash: Buffer, activeSince: Date, opts: LockOption = {}) {
    return this.findOne(
      q,
      `c.tenant_id = $1 AND c.guest_token_hash = $2 AND c.user_id IS NULL AND c.status = 'active' AND c.last_activity_at > $3`,
      [tenantId, tokenHash, activeSince],
      opts,
    );
  }

  findById(q: Queryable, tenantId: string, id: string, opts: LockOption = {}): Promise<Cart | null> {
    return this.findOne(q, `c.tenant_id = $1 AND c.id = $2`, [tenantId, id], opts);
  }

  private async findOne(q: Queryable, where: string, values: unknown[], opts: LockOption): Promise<Cart | null> {
    const { rows } = await q.query<CartRow>(
      `SELECT ${COLUMNS} FROM sales.carts c WHERE ${where} ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      values,
    );
    const r = rows[0];
    if (!r) return null;
    const items = await q.query<ItemRow>(
      `SELECT variant_id, quantity, price_at_add, added_at FROM sales.cart_items WHERE cart_id = $1 ORDER BY added_at, variant_id`,
      [r.id],
    );
    return Cart.restore({
      id: r.id,
      tenantId: r.tenant_id,
      userId: r.user_id,
      guestTokenHash: r.guest_token_hash,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      currency: r.currency,
      couponCodes: r.coupon_codes,
      status: r.status,
      lastActivityAt: r.last_activity_at,
      createdAt: r.created_at,
      items: items.rows.map(
        (i): CartItem => ({ variantId: i.variant_id, quantity: i.quantity, priceAtAdd: i.price_at_add, addedAt: i.added_at }),
      ),
    });
  }

  async insert(q: Queryable, cart: Cart): Promise<boolean> {
    const c = cart.toJSON();
    const res = await q.query(
      `INSERT INTO sales.carts
         (id, tenant_id, user_id, guest_token_hash, contact_email, contact_phone, currency, coupon_codes, status,
          last_activity_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id) WHERE status = 'active' DO NOTHING`,
      [c.id, c.tenantId, c.userId, c.guestTokenHash, c.contactEmail, c.contactPhone, c.currency, c.couponCodes, c.status, c.lastActivityAt, c.createdAt],
    );
    return res.rowCount === 1;
  }

  async save(q: Queryable, cart: Cart): Promise<void> {
    const c = cart.toJSON();
    await q.query(
      `UPDATE sales.carts
          SET user_id = $3, contact_email = $4, contact_phone = $5, coupon_codes = $6, status = $7, last_activity_at = $8,
              reminders_sent = CASE WHEN last_activity_at IS DISTINCT FROM $8 THEN 0 ELSE reminders_sent END
        WHERE tenant_id = $1 AND id = $2`,
      [c.tenantId, c.id, c.userId, c.contactEmail, c.contactPhone, c.couponCodes, c.status, c.lastActivityAt],
    );
    await q.query(`DELETE FROM sales.cart_items WHERE cart_id = $1`, [c.id]);
    if (c.items.length === 0) return;
    await q.query(
      `INSERT INTO sales.cart_items (cart_id, variant_id, quantity, price_at_add, added_at)
       SELECT $1, t.variant_id, t.quantity, t.price_at_add, t.added_at
         FROM unnest($2::uuid[], $3::int[], $4::numeric[], $5::timestamptz[]) AS t(variant_id, quantity, price_at_add, added_at)`,
      [c.id, c.items.map((i) => i.variantId), c.items.map((i) => i.quantity), c.items.map((i) => i.priceAtAdd), c.items.map((i) => i.addedAt)],
    );
  }

  async claimAbandonmentCandidates(
    q: Queryable,
    idleBefore: Date,
    maxReminders: number,
    limit: number,
    tenantId?: string,
  ): Promise<AbandonmentCandidate[]> {
    const { rows } = await q.query<{
      id: string;
      tenant_id: string;
      user_id: string | null;
      contact_email: string | null;
      contact_phone: string | null;
      reminders_sent: number;
      last_activity_at: Date;
    }>(
      `SELECT c.id, c.tenant_id, c.user_id, c.contact_email::text AS contact_email, c.contact_phone, c.reminders_sent, c.last_activity_at
         FROM sales.carts c
        WHERE c.status = 'active'
          AND c.last_activity_at <= $1
          AND c.reminders_sent < $2
          AND (c.contact_email IS NOT NULL OR c.contact_phone IS NOT NULL OR c.user_id IS NOT NULL)
          AND ($4::uuid IS NULL OR c.tenant_id = $4)
          AND EXISTS (SELECT 1 FROM sales.cart_items i WHERE i.cart_id = c.id)
        ORDER BY c.last_activity_at
        LIMIT $3
        FOR UPDATE OF c SKIP LOCKED`,
      [idleBefore, maxReminders, limit, tenantId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      userId: r.user_id,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      remindersSent: r.reminders_sent,
      lastActivityAt: r.last_activity_at,
    }));
  }

  async recordReminder(q: Queryable, cartId: string, expected: number, sent: number): Promise<boolean> {
    const res = await q.query(
      `UPDATE sales.carts
          SET reminders_sent = $3
        WHERE id = $1 AND reminders_sent = $2 AND status = 'active'`,
      [cartId, expected, sent],
    );
    return res.rowCount === 1;
  }
}
