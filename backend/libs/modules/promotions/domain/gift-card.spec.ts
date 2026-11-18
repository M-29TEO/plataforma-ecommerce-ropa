import { toCents } from '../../../shared-kernel';
import { GiftCardInsufficientBalanceError, GiftCardNotUsableError, InvalidGiftCardOperationError } from './errors';
import { GiftCard, GiftCardTransaction, generateGiftCardCode, hashGiftCardCode, normalizeGiftCardCode } from './gift-card';

const T0 = new Date('2026-09-29T15:00:00Z');
const later = (days: number) => new Date(T0.getTime() + days * 86_400_000);

/** Suma con signo del libro de movimientos. */
const ledger = (txs: GiftCardTransaction[]) =>
  txs.reduce((s, t) => s + (t.amount.startsWith('-') ? -toCents(t.amount.slice(1)) : toCents(t.amount)), 0);

describe('códigos de gift card', () => {
  it('16 caracteres Crockford en 4 grupos, distintos cada vez', () => {
    const code = generateGiftCardCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(new Set(Array.from({ length: 200 }, generateGiftCardCode)).size).toBe(200);
  });

  it('normaliza minúsculas, espacios, guiones y letras confusas', () => {
    expect(normalizeGiftCardCode('7k2q-m9xd 4trb-a0cz')).toBe('7K2QM9XD4TRBA0CZ');
    expect(normalizeGiftCardCode('7K2Q-M9XD-4TRB-AOCZ')).toBe('7K2QM9XD4TRBA0CZ'); // O → 0
    expect(normalizeGiftCardCode('IIII-LLLL-0000-1111')).toBe('1111111100001111');
    expect(normalizeGiftCardCode('corto')).toBeNull();
    expect(normalizeGiftCardCode('UUUU-UUUU-UUUU-UUUU')).toBeNull(); // U no pertenece al alfabeto
  });

  it('el hash no depende del formato con que se ingrese', () => {
    expect(hashGiftCardCode(normalizeGiftCardCode('7k2q m9xd 4trb a0cz')!)).toEqual(hashGiftCardCode('7K2QM9XD4TRBA0CZ'));
  });
});

describe('GiftCard', () => {
  function issue(amount = '50.00', extra: Partial<Parameters<typeof GiftCard.issue>[0]> = {}) {
    return GiftCard.issue({ tenantId: 't', amount, ...extra }, T0);
  }

  it('emisión: saldo inicial, últimos 4 del código y movimiento issue', () => {
    const { card, code, transaction } = issue('50');
    const p = card.toJSON();
    expect(p).toMatchObject({ initialAmount: '50.00', balance: '50.00', status: 'active', last4: code.slice(-4) });
    expect(p.codeHash).toEqual(hashGiftCardCode(normalizeGiftCardCode(code)!));
    expect(transaction).toMatchObject({ type: 'issue', amount: '50.00', orderId: null });
  });

  it.each(['0', '5000.01'])('rechaza emitir por %s', (amount) => {
    expect(() => issue(amount)).toThrow(InvalidGiftCardOperationError);
  });

  it('canje parcial, total (depleted) y saldo insuficiente', () => {
    const { card } = issue('50');
    expect(card.redeem('20', 'o1', T0)).toMatchObject({ type: 'redeem', amount: '-20.00', orderId: 'o1' });
    expect(card.toJSON()).toMatchObject({ balance: '30.00', status: 'active' });
    expect(() => card.redeem('30.01', 'o2', T0)).toThrow(GiftCardInsufficientBalanceError);
    card.redeem('30', 'o2', T0);
    expect(card.toJSON()).toMatchObject({ balance: '0.00', status: 'depleted' });
  });

  it('no se usa bloqueada, pendiente ni vencida', () => {
    const blocked = issue().card;
    blocked.block();
    expect(() => blocked.redeem('1', 'o', T0)).toThrow(expect.objectContaining({ code: 'GIFT_CARD_BLOCKED' }));

    const pending = issue('50', { status: 'pending' }).card;
    expect(() => pending.redeem('1', 'o', T0)).toThrow(expect.objectContaining({ code: 'GIFT_CARD_PENDING' }));
    pending.activate();
    expect(() => pending.redeem('1', 'o', T0)).not.toThrow();

    const expiring = issue('50', { expiresAt: later(30) }).card;
    expect(expiring.effectiveStatus(later(29))).toBe('active');
    expect(expiring.effectiveStatus(later(30))).toBe('expired');
    expect(() => expiring.redeem('1', 'o', later(31))).toThrow(GiftCardNotUsableError);
  });

  it('el reembolso devuelve saldo y reactiva una tarjeta agotada', () => {
    const { card } = issue('25');
    card.redeem('25', 'o1', T0);
    expect(card.toJSON().status).toBe('depleted');
    expect(card.refund('10', 'o1', T0)).toMatchObject({ type: 'refund', amount: '10.00' });
    expect(card.toJSON()).toMatchObject({ balance: '10.00', status: 'active' });
  });

  it('el ajuste manual nunca deja saldo negativo', () => {
    const { card } = issue('10');
    expect(() => card.adjust(-1001)).toThrow(GiftCardInsufficientBalanceError);
    expect(card.adjust(-1000)).toMatchObject({ type: 'adjust', amount: '-10.00' });
    expect(card.toJSON().status).toBe('depleted');
    card.adjust(500);
    expect(card.toJSON()).toMatchObject({ balance: '5.00', status: 'active' });
  });

  it('invariante: la suma del libro de movimientos es el saldo', () => {
    const { card, transaction } = issue('100');
    const txs = [transaction, card.redeem('35.50', 'o1', T0), card.refund('10', 'o1', T0), card.adjust(-425), card.redeem('0.01', 'o2', T0)];
    expect(ledger(txs)).toBe(card.balanceCents);
    expect(card.toJSON().balance).toBe('70.24');
  });
});
