import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fromCents, toCents } from '../../../shared-kernel';
import { GiftCardInsufficientBalanceError, GiftCardNotUsableError, InvalidGiftCardOperationError } from './errors';

export type GiftCardStatus = 'pending' | 'active' | 'depleted' | 'expired' | 'blocked';
export type GiftCardTransactionType = 'issue' | 'redeem' | 'refund' | 'adjust' | 'expire';

/**
 * El código completo solo se conoce al emitir la tarjeta: la base guarda su SHA-256
 * (code_hash) y los últimos 4 caracteres para mostrarla ("•••• 7K2Q").
 */
export interface GiftCardProps {
  id: string;
  tenantId: string;
  codeHash: Buffer;
  last4: string;
  initialAmount: string;
  balance: string;
  currency: string;
  purchaserId: string | null;
  recipientEmail: string | null;
  status: GiftCardStatus;
  expiresAt: Date | null;
  createdAt: Date;
}

/**
 * Libro de movimientos: amount con signo (issue/refund suman, redeem/expire restan, adjust
 * según el caso). Invariante: SUM(amount) = balance.
 */
export interface GiftCardTransaction {
  giftCardId: string;
  orderId: string | null;
  amount: string;
  type: GiftCardTransactionType;
  createdAt: Date;
}

/** Base32 de Crockford: sin I, L, O ni U para evitar confusiones al dictar o tipear el código. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 16; // 80 bits de entropía
const MAX_AMOUNT_CENTS = 5_000_00;

/** "7K2Q-M9XD-4TRB-A0CZ". */
export function generateGiftCardCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

/** Acepta minúsculas, espacios y guiones; O → 0 e I/L → 1 como define Crockford. Null si no es un código válido. */
export function normalizeGiftCardCode(input: string): string | null {
  const clean = (input ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length !== CODE_LENGTH || [...clean].some((c) => !ALPHABET.includes(c))) return null;
  return clean;
}

export function hashGiftCardCode(normalized: string): Buffer {
  return createHash('sha256').update(normalized, 'utf8').digest();
}

export interface IssueGiftCardInput {
  tenantId: string;
  amount: string | number;
  purchaserId?: string | null;
  recipientEmail?: string | null;
  expiresAt?: Date | null;
  /** 'pending' si se vende en línea y se activa al pagarse el pedido. */
  status?: 'active' | 'pending';
}

export class GiftCard {
  private constructor(private props: GiftCardProps) {}

  static issue(input: IssueGiftCardInput, now = new Date()): { card: GiftCard; code: string; transaction: GiftCardTransaction } {
    const cents = toCents(input.amount);
    if (cents <= 0 || cents > MAX_AMOUNT_CENTS) {
      throw new InvalidGiftCardOperationError('INVALID_GIFT_CARD_AMOUNT', `El monto debe ser mayor que 0 y hasta ${fromCents(MAX_AMOUNT_CENTS)}`);
    }
    if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
      throw new InvalidGiftCardOperationError('INVALID_GIFT_CARD_EXPIRY', 'La fecha de vencimiento debe ser futura');
    }
    const code = generateGiftCardCode();
    const normalized = normalizeGiftCardCode(code)!;
    const amount = fromCents(cents);
    const card = new GiftCard({
      id: randomUUID(),
      tenantId: input.tenantId,
      codeHash: hashGiftCardCode(normalized),
      last4: normalized.slice(-4),
      initialAmount: amount,
      balance: amount,
      currency: 'USD',
      purchaserId: input.purchaserId ?? null,
      recipientEmail: input.recipientEmail?.trim().toLowerCase() || null,
      status: input.status ?? 'active',
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
    });
    return { card, code, transaction: card.tx('issue', cents, null, now) };
  }

  static restore(props: GiftCardProps): GiftCard {
    return new GiftCard({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get balanceCents(): number {
    return toCents(this.props.balance);
  }

  toJSON(): GiftCardProps {
    return { ...this.props };
  }

  /** Estado visible: una tarjeta activa con expires_at pasado está vencida aunque el job no haya corrido. */
  effectiveStatus(now = new Date()): GiftCardStatus {
    const s = this.props.status;
    if ((s === 'active' || s === 'depleted') && this.props.expiresAt && this.props.expiresAt.getTime() <= now.getTime()) {
      return 'expired';
    }
    return s;
  }

  private tx(type: GiftCardTransactionType, signedCents: number, orderId: string | null, now: Date): GiftCardTransaction {
    return { giftCardId: this.props.id, orderId, amount: fromCents(signedCents), type, createdAt: now };
  }

  private setBalance(cents: number): void {
    this.props.balance = fromCents(cents);
    if (this.props.status === 'active' && cents === 0) this.props.status = 'depleted';
    else if (this.props.status === 'depleted' && cents > 0) this.props.status = 'active';
  }

  redeem(amount: string | number, orderId: string, now = new Date()): GiftCardTransaction {
    const cents = toCents(amount);
    if (cents <= 0) throw new InvalidGiftCardOperationError('INVALID_AMOUNT', 'El monto a usar debe ser mayor que 0');
    const status = this.effectiveStatus(now);
    if (status === 'expired') throw new GiftCardNotUsableError('GIFT_CARD_EXPIRED', 'La gift card está vencida');
    if (status === 'blocked') throw new GiftCardNotUsableError('GIFT_CARD_BLOCKED', 'La gift card está bloqueada');
    if (status === 'pending') throw new GiftCardNotUsableError('GIFT_CARD_PENDING', 'La gift card todavía no está activa');
    if (cents > this.balanceCents) throw new GiftCardInsufficientBalanceError(this.props.balance, fromCents(cents));
    this.setBalance(this.balanceCents - cents);
    return this.tx('redeem', -cents, orderId, now);
  }

  /** Devuelve saldo por un pedido cancelado o devuelto. */
  refund(amount: string | number, orderId: string, now = new Date()): GiftCardTransaction {
    const cents = toCents(amount);
    if (cents <= 0) throw new InvalidGiftCardOperationError('INVALID_AMOUNT', 'El monto a devolver debe ser mayor que 0');
    this.setBalance(this.balanceCents + cents);
    return this.tx('refund', cents, orderId, now);
  }

  /** Corrección manual del saldo (backoffice). El saldo nunca queda negativo. */
  adjust(deltaCents: number, now = new Date()): GiftCardTransaction {
    if (!Number.isInteger(deltaCents) || deltaCents === 0) {
      throw new InvalidGiftCardOperationError('INVALID_AMOUNT', 'El ajuste debe ser distinto de 0');
    }
    const next = this.balanceCents + deltaCents;
    if (next < 0) throw new GiftCardInsufficientBalanceError(this.props.balance, fromCents(-deltaCents));
    if (next > MAX_AMOUNT_CENTS) {
      throw new InvalidGiftCardOperationError('INVALID_GIFT_CARD_AMOUNT', `El saldo no puede superar ${fromCents(MAX_AMOUNT_CENTS)}`);
    }
    this.setBalance(next);
    return this.tx('adjust', deltaCents, null, now);
  }

  activate(): void {
    if (this.props.status !== 'pending') {
      throw new GiftCardNotUsableError('GIFT_CARD_NOT_PENDING', 'Solo se activa una gift card pendiente', { status: this.props.status });
    }
    this.props.status = this.balanceCents > 0 ? 'active' : 'depleted';
  }

  block(): void {
    this.props.status = 'blocked';
  }
}
