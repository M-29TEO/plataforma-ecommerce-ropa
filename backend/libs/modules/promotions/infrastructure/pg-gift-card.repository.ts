import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { GiftCardFilter, GiftCardRepository, GiftCardTransactionRow } from '../application/ports';
import { GiftCard, GiftCardProps, GiftCardTransaction, GiftCardTransactionType } from '../domain/gift-card';

const COLUMNS = `g.id, g.tenant_id, g.code_hash, g.last4, g.initial_amount, g.balance, g.currency, g.purchaser_id,
  g.recipient_email::text AS recipient_email, g.status, g.expires_at, g.created_at`;

interface Row {
  id: string;
  tenant_id: string;
  code_hash: Buffer;
  last4: string;
  initial_amount: string;
  balance: string;
  currency: string;
  purchaser_id: string | null;
  recipient_email: string | null;
  status: GiftCardProps['status'];
  expires_at: Date | null;
  created_at: Date;
}

interface TxRow {
  id: string;
  gift_card_id: string;
  order_id: string | null;
  amount: string;
  type: GiftCardTransactionType;
  created_at: Date;
}

function toCard(r: Row): GiftCard {
  return GiftCard.restore({
    id: r.id,
    tenantId: r.tenant_id,
    codeHash: r.code_hash,
    last4: r.last4,
    initialAmount: r.initial_amount,
    balance: r.balance,
    currency: r.currency,
    purchaserId: r.purchaser_id,
    recipientEmail: r.recipient_email,
    status: r.status,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  });
}

function toTx(r: TxRow): GiftCardTransactionRow {
  return { id: r.id, giftCardId: r.gift_card_id, orderId: r.order_id, amount: r.amount, type: r.type, createdAt: r.created_at };
}

@Injectable()
export class PgGiftCardRepository extends GiftCardRepository {
  async insert(q: Queryable, card: GiftCard): Promise<boolean> {
    const c = card.toJSON();
    const res = await q.query(
      `INSERT INTO sales.gift_cards
         (id, tenant_id, code_hash, last4, initial_amount, balance, currency, purchaser_id, recipient_email, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (code_hash) DO NOTHING`,
      [c.id, c.tenantId, c.codeHash, c.last4, c.initialAmount, c.balance, c.currency, c.purchaserId, c.recipientEmail, c.status, c.expiresAt, c.createdAt],
    );
    return res.rowCount === 1;
  }

  async findById(q: Queryable, tenantId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<GiftCard | null> {
    const { rows } = await q.query<Row>(
      `SELECT ${COLUMNS} FROM sales.gift_cards g WHERE g.tenant_id = $1 AND g.id = $2 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, id],
    );
    return rows[0] ? toCard(rows[0]) : null;
  }

  async findByCodeHash(q: Queryable, tenantId: string, codeHash: Buffer, opts: { forUpdate?: boolean } = {}): Promise<GiftCard | null> {
    const { rows } = await q.query<Row>(
      `SELECT ${COLUMNS} FROM sales.gift_cards g WHERE g.tenant_id = $1 AND g.code_hash = $2 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, codeHash],
    );
    return rows[0] ? toCard(rows[0]) : null;
  }

  async list(q: Queryable, tenantId: string, f: GiftCardFilter): Promise<GiftCard[]> {
    const where = ['g.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (f.status) where.push(`g.status = $${values.push(f.status)}`);
    const limit = values.push(f.limit);
    const offset = values.push(f.offset);
    const { rows } = await q.query<Row>(
      `SELECT ${COLUMNS} FROM sales.gift_cards g WHERE ${where.join(' AND ')}
        ORDER BY g.created_at DESC, g.id LIMIT $${limit} OFFSET $${offset}`,
      values,
    );
    return rows.map(toCard);
  }

  async save(q: Queryable, card: GiftCard): Promise<void> {
    const c = card.toJSON();
    await q.query(`UPDATE sales.gift_cards SET balance = $3, status = $4 WHERE tenant_id = $1 AND id = $2`, [
      c.tenantId,
      c.id,
      c.balance,
      c.status,
    ]);
  }

  async insertTransaction(q: Queryable, t: GiftCardTransaction): Promise<void> {
    await q.query(
      `INSERT INTO sales.gift_card_transactions (gift_card_id, order_id, amount, type, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [t.giftCardId, t.orderId, t.amount, t.type, t.createdAt],
    );
  }

  async listTransactions(q: Queryable, giftCardId: string): Promise<GiftCardTransactionRow[]> {
    const { rows } = await q.query<TxRow>(
      `SELECT t.id::text, t.gift_card_id, t.order_id, t.amount, t.type, t.created_at
         FROM sales.gift_card_transactions t WHERE t.gift_card_id = $1 ORDER BY t.id`,
      [giftCardId],
    );
    return rows.map(toTx);
  }

  async findOrderTransactions(
    q: Queryable,
    tenantId: string,
    orderId: string,
    types?: GiftCardTransactionType[],
  ): Promise<GiftCardTransactionRow[]> {
    const { rows } = await q.query<TxRow>(
      `SELECT t.id::text, t.gift_card_id, t.order_id, t.amount, t.type, t.created_at
         FROM sales.gift_card_transactions t JOIN sales.gift_cards g ON g.id = t.gift_card_id
        WHERE g.tenant_id = $1 AND t.order_id = $2 AND ($3::text[] IS NULL OR t.type = ANY($3::text[]))
        ORDER BY t.id`,
      [tenantId, orderId, types ?? null],
    );
    return rows.map(toTx);
  }
}
