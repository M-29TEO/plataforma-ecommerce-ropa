import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { WishlistItem, WishlistObservationUpdate, WishlistRepository, WishlistScanCursor } from '../application/ports';

interface Row {
  tenant_id: string;
  user_id: string;
  product_id: string;
  variant_id: string | null;
  notify_back_in_stock: boolean;
  notify_price_drop: boolean;
  last_known_price: string | null;
  last_known_in_stock: boolean | null;
  last_alerted_at: Date | null;
  added_at: Date;
}

const COLUMNS = `tenant_id, user_id, product_id, variant_id, notify_back_in_stock, notify_price_drop,
  last_known_price, last_known_in_stock, last_alerted_at, added_at`;

function toItem(r: Row): WishlistItem {
  return {
    tenantId: r.tenant_id,
    userId: r.user_id,
    productId: r.product_id,
    variantId: r.variant_id,
    notifyBackInStock: r.notify_back_in_stock,
    notifyPriceDrop: r.notify_price_drop,
    lastKnownPrice: r.last_known_price,
    lastKnownInStock: r.last_known_in_stock,
    lastAlertedAt: r.last_alerted_at,
    addedAt: r.added_at,
  };
}

@Injectable()
export class PgWishlistRepository extends WishlistRepository {
  async lockOwner(q: Queryable, tenantId: string, userId: string): Promise<void> {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`crm.wishlist:${tenantId}:${userId}`]);
  }

  async list(q: Queryable, tenantId: string, userId: string): Promise<WishlistItem[]> {
    const { rows } = await q.query<Row>(`SELECT ${COLUMNS} FROM crm.wishlist_items WHERE tenant_id = $1 AND user_id = $2 ORDER BY added_at DESC`, [
      tenantId,
      userId,
    ]);
    return rows.map(toItem);
  }

  async count(q: Queryable, tenantId: string, userId: string): Promise<number> {
    const { rows } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm.wishlist_items WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
    return rows[0].n;
  }

  async find(q: Queryable, tenantId: string, userId: string, productId: string): Promise<WishlistItem | null> {
    const { rows } = await q.query<Row>(`SELECT ${COLUMNS} FROM crm.wishlist_items WHERE tenant_id = $1 AND user_id = $2 AND product_id = $3`, [
      tenantId,
      userId,
      productId,
    ]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async upsert(q: Queryable, i: WishlistItem): Promise<WishlistItem> {
    const { rows } = await q.query<Row>(
      `INSERT INTO crm.wishlist_items (tenant_id, user_id, product_id, variant_id, notify_back_in_stock, notify_price_drop,
         last_known_price, last_known_in_stock, last_alerted_at, added_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, product_id) DO UPDATE SET
         variant_id = EXCLUDED.variant_id,
         notify_back_in_stock = EXCLUDED.notify_back_in_stock,
         notify_price_drop = EXCLUDED.notify_price_drop,
         last_known_price = EXCLUDED.last_known_price,
         last_known_in_stock = EXCLUDED.last_known_in_stock,
         last_alerted_at = EXCLUDED.last_alerted_at
       WHERE crm.wishlist_items.tenant_id = EXCLUDED.tenant_id
       RETURNING ${COLUMNS}`,
      [i.tenantId, i.userId, i.productId, i.variantId, i.notifyBackInStock, i.notifyPriceDrop, i.lastKnownPrice, i.lastKnownInStock, i.lastAlertedAt, i.addedAt],
    );
    return toItem(rows[0]);
  }

  async delete(q: Queryable, tenantId: string, userId: string, productId: string): Promise<boolean> {
    const r = await q.query(`DELETE FROM crm.wishlist_items WHERE tenant_id = $1 AND user_id = $2 AND product_id = $3`, [tenantId, userId, productId]);
    return (r.rowCount ?? 0) > 0;
  }

  async listForScan(q: Queryable, after: WishlistScanCursor | null, limit: number, tenantId: string | null = null): Promise<WishlistItem[]> {
    const where: string[] = ['(notify_back_in_stock OR notify_price_drop)'];
    const values: unknown[] = [];
    if (tenantId) where.push(`tenant_id = $${values.push(tenantId)}`);
    if (after) {
      const a = values.push(after.tenantId);
      const b = values.push(after.userId);
      const c = values.push(after.productId);
      where.push(`(tenant_id, user_id, product_id) > ($${a}::uuid, $${b}::uuid, $${c}::uuid)`);
    }
    const { rows } = await q.query<Row>(
      `SELECT ${COLUMNS} FROM crm.wishlist_items WHERE ${where.join(' AND ')}
        ORDER BY tenant_id, user_id, product_id LIMIT $${values.push(limit)}`,
      values,
    );
    return rows.map(toItem);
  }

  async saveObservation(q: Queryable, i: Pick<WishlistItem, 'tenantId' | 'userId' | 'productId'>, next: WishlistObservationUpdate): Promise<void> {
    await q.query(
      `UPDATE crm.wishlist_items SET last_known_price = $4, last_known_in_stock = $5, last_alerted_at = $6
        WHERE tenant_id = $1 AND user_id = $2 AND product_id = $3`,
      [i.tenantId, i.userId, i.productId, next.lastKnownPrice, next.lastKnownInStock, next.lastAlertedAt],
    );
  }
}
