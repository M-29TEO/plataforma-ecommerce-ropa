import { Injectable } from '@nestjs/common';
import { Database, fromCents, Queryable, toCents, ValidationError } from '../../../shared-kernel';
import { GiftCardNotFoundError, InvalidGiftCardOperationError } from '../domain/errors';
import { GiftCard, GiftCardProps, GiftCardStatus, hashGiftCardCode, IssueGiftCardInput, normalizeGiftCardCode } from '../domain/gift-card';
import { GiftCardFilter, GiftCardRepository, GiftCardTransactionRow } from './ports';

/** Lo que ve el backoffice: nunca el hash del código. status es el efectivo (vencida si pasó expires_at). */
export type GiftCardView = Omit<GiftCardProps, 'codeHash'>;
export type GiftCardDetail = GiftCardView & { transactions: GiftCardTransactionRow[] };

export interface GiftCardBalance {
  last4: string;
  balance: string;
  currency: string;
  status: GiftCardStatus;
  expiresAt: Date | null;
}

export interface GiftCardRedemption {
  giftCardId: string;
  last4: string;
  amount: string;
  balance: string;
}

const MAX_ISSUE_ATTEMPTS = 3;

function view(card: GiftCard, now = new Date()): GiftCardView {
  const { codeHash: _hash, ...rest } = card.toJSON();
  return { ...rest, status: card.effectiveStatus(now) };
}

/**
 * Gift cards: saldo + libro de movimientos (gift_card_transactions). Cada operación bloquea la
 * fila de la tarjeta (FOR UPDATE) y escribe saldo y movimiento en la misma transacción, así dos
 * checkouts simultáneos con la misma tarjeta no gastan más que el saldo.
 */
@Injectable()
export class GiftCardService {
  constructor(
    private readonly db: Database,
    private readonly cards: GiftCardRepository,
  ) {}

  /** Devuelve el código en claro UNA sola vez; después solo existe su hash. */
  async issue(input: IssueGiftCardInput): Promise<{ giftCard: GiftCardView; code: string }> {
    for (let attempt = 1; ; attempt++) {
      const { card, code, transaction } = GiftCard.issue(input);
      const inserted = await this.db.withTransaction(async (tx) => {
        if (!(await this.cards.insert(tx, card))) return false;
        await this.cards.insertTransaction(tx, transaction);
        return true;
      });
      if (inserted) return { giftCard: view(card), code };
      if (attempt >= MAX_ISSUE_ATTEMPTS) throw new Error('No se pudo generar un código de gift card único');
    }
  }

  async get(tenantId: string, id: string): Promise<GiftCardDetail> {
    const card = await this.cards.findById(this.db, tenantId, id);
    if (!card) throw new GiftCardNotFoundError({ giftCardId: id });
    return { ...view(card), transactions: await this.cards.listTransactions(this.db, id) };
  }

  async list(tenantId: string, filter: GiftCardFilter): Promise<GiftCardView[]> {
    const now = new Date();
    return (await this.cards.list(this.db, tenantId, filter)).map((c) => view(c, now));
  }

  async balance(tenantId: string, code: string): Promise<GiftCardBalance> {
    const card = await this.findByCode(this.db, tenantId, code);
    const v = view(card);
    return { last4: v.last4, balance: v.balance, currency: v.currency, status: v.status, expiresAt: v.expiresAt };
  }

  /** Checkout. Idempotente por (tarjeta, pedido): un reintento devuelve el canje ya hecho. */
  redeem(tenantId: string, code: string, orderId: string, amount: string): Promise<GiftCardRedemption> {
    return this.db.withTransaction(async (tx) => {
      const card = await this.findByCode(tx, tenantId, code, true);
      const previous = (await this.cards.findOrderTransactions(tx, tenantId, orderId, ['redeem'])).find(
        (t) => t.giftCardId === card.id,
      );
      const result = (redeemed: string): GiftCardRedemption => {
        const p = card.toJSON();
        return { giftCardId: p.id, last4: p.last4, amount: fromCents(-signedCents(redeemed)), balance: p.balance };
      };
      if (previous) return result(previous.amount);
      const movement = card.redeem(amount, orderId);
      await this.cards.save(tx, card);
      await this.cards.insertTransaction(tx, movement);
      return result(movement.amount);
    });
  }

  /**
   * Pedido cancelado o devuelto: devuelve a las tarjetas usadas en el pedido hasta `amount`
   * (por defecto, todo lo neto canjeado), en el orden en que se usaron. Nunca devuelve más de
   * lo que se canjeó, aunque se llame varias veces.
   */
  refundOrder(tenantId: string, orderId: string, amount?: string): Promise<{ refunded: string }> {
    return this.db.withTransaction(async (tx) => {
      const movements = await this.cards.findOrderTransactions(tx, tenantId, orderId, ['redeem', 'refund']);
      const netByCard = new Map<string, number>();
      for (const m of movements) netByCard.set(m.giftCardId, (netByCard.get(m.giftCardId) ?? 0) - signedCents(m.amount));
      let pending = amount === undefined ? [...netByCard.values()].reduce((a, b) => a + b, 0) : toCents(amount);
      if (amount !== undefined && pending <= 0) {
        throw new InvalidGiftCardOperationError('INVALID_AMOUNT', 'El monto a devolver debe ser mayor que 0');
      }
      let refunded = 0;
      for (const cardId of [...netByCard.keys()].sort()) {
        const refundable = netByCard.get(cardId)!;
        if (pending <= 0 || refundable <= 0) continue;
        const card = await this.cards.findById(tx, tenantId, cardId, { forUpdate: true });
        if (!card) continue;
        const part = Math.min(pending, refundable);
        const movement = card.refund(fromCents(part), orderId);
        await this.cards.save(tx, card);
        await this.cards.insertTransaction(tx, movement);
        pending -= part;
        refunded += part;
      }
      if (amount !== undefined && pending > 0) {
        throw new InvalidGiftCardOperationError('REFUND_EXCEEDS_REDEEMED', 'El monto supera lo canjeado con gift cards en el pedido', {
          refundable: fromCents(refunded),
        });
      }
      return { refunded: fromCents(refunded) };
    });
  }

  /** delta con signo: "-5.00" resta, "10" suma. */
  adjust(tenantId: string, id: string, delta: string): Promise<GiftCardDetail> {
    const cents = signedCents(delta);
    return this.mutate(tenantId, id, async (tx, card) => {
      await this.cards.insertTransaction(tx, card.adjust(cents));
    });
  }

  block(tenantId: string, id: string): Promise<GiftCardDetail> {
    return this.mutate(tenantId, id, async (_tx, card) => card.block());
  }

  /** Gift card vendida en línea: se activa cuando se paga el pedido que la compró. */
  activate(tenantId: string, id: string): Promise<GiftCardDetail> {
    return this.mutate(tenantId, id, async (_tx, card) => card.activate());
  }

  private async mutate(tenantId: string, id: string, fn: (tx: Queryable, card: GiftCard) => Promise<void>): Promise<GiftCardDetail> {
    await this.db.withTransaction(async (tx) => {
      const card = await this.cards.findById(tx, tenantId, id, { forUpdate: true });
      if (!card) throw new GiftCardNotFoundError({ giftCardId: id });
      await fn(tx, card);
      await this.cards.save(tx, card);
    });
    return this.get(tenantId, id);
  }

  private async findByCode(q: Queryable, tenantId: string, code: string, forUpdate = false): Promise<GiftCard> {
    const normalized = normalizeGiftCardCode(code);
    // Mismo error para un código mal formado y uno inexistente: no se da pista para adivinar.
    if (!normalized) throw new GiftCardNotFoundError();
    const card = await this.cards.findByCodeHash(q, tenantId, hashGiftCardCode(normalized), { forUpdate });
    if (!card) throw new GiftCardNotFoundError();
    return card;
  }
}

/** "-5.25" → -525. toCents no admite signo. */
function signedCents(value: string): number {
  const text = String(value).trim();
  if (!/^-?\d{1,10}(\.\d{1,2})?$/.test(text)) throw new ValidationError('INVALID_MONEY', `Monto inválido: "${value}"`);
  return text.startsWith('-') ? -toCents(text.slice(1)) : toCents(text);
}
