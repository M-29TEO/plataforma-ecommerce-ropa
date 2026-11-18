import { InvalidPaymentError, InvalidPaymentTransitionError, VoucherUnderReviewError } from './errors';
import { PAYMENT_CAPTURED, PAYMENT_EXPIRED, PAYMENT_FAILED } from './events';
import { NewPayment, Payment } from './payment';

const NOW = new Date('2026-09-29T15:00:00Z');
const LATER = new Date('2026-09-29T15:30:00Z');

function newPayment(overrides: Partial<NewPayment> = {}): Payment {
  return Payment.create(
    {
      tenantId: 't1',
      orderId: 'o1',
      method: 'card',
      provider: 'simulator',
      amount: '46.00',
      idempotencyKey: 'user:u1:k1',
      expiresAt: new Date('2026-09-29T15:15:00Z'),
      ...overrides,
    },
    NOW,
  );
}

describe('Payment', () => {
  it('se crea pendiente; la transferencia empieza en requires_action', () => {
    expect(newPayment().status).toBe('pending');
    expect(newPayment({ method: 'transfer', provider: 'manual' }).status).toBe('requires_action');
  });

  it('rechaza montos no positivos y métodos desconocidos', () => {
    expect(() => newPayment({ amount: '0.00' })).toThrow(InvalidPaymentError);
    expect(() => newPayment({ method: 'bitcoin' as never })).toThrow(InvalidPaymentError);
  });

  it('capturar emite PaymentCaptured una sola vez (idempotente)', () => {
    const p = newPayment();
    const first = p.capture({ source: 'webhook:evt_1', authorizationCode: '123456', cardBrand: 'visa', cardLast4: '4242' }, NOW);
    expect(first.changed).toBe(true);
    expect(first.events.map((e) => e.eventType)).toEqual([PAYMENT_CAPTURED]);
    expect(first.events[0].payload).toMatchObject({ paymentId: p.id, orderId: 'o1', amount: '46.00', method: 'card' });
    expect(p.toJSON()).toMatchObject({ status: 'captured', authorizationCode: '123456', cardLast4: '4242', capturedAt: NOW });

    const again = p.capture({ source: 'webhook:evt_2' }, NOW);
    expect(again).toEqual({ changed: false, events: [], record: null });
  });

  it('no captura un pago vencido aunque el job todavía no lo haya marcado', () => {
    const p = newPayment();
    expect(() => p.capture({ source: 'webhook' }, LATER)).toThrow(InvalidPaymentTransitionError);
    expect(p.status).toBe('pending');
  });

  it('rechazar emite PaymentFailed con el motivo; luego no se puede capturar', () => {
    const p = newPayment();
    const change = p.fail('INSUFFICIENT_FUNDS', 'Fondos insuficientes', 'webhook', NOW);
    expect(change.events.map((e) => e.eventType)).toEqual([PAYMENT_FAILED]);
    expect(change.events[0].payload).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', failureMessage: 'Fondos insuficientes' });
    expect(p.fail('X', null, 'webhook').changed).toBe(false);
    expect(() => p.capture({ source: 'webhook' }, NOW)).toThrow(InvalidPaymentTransitionError);
  });

  it('un pago capturado no se puede rechazar', () => {
    const p = newPayment();
    p.capture({ source: 'webhook' }, NOW);
    expect(() => p.fail('LATE', null, 'webhook')).toThrow(InvalidPaymentTransitionError);
  });

  it('vence solo después de expires_at y emite PaymentExpired', () => {
    const p = newPayment();
    expect(() => p.expire(NOW)).toThrow(InvalidPaymentTransitionError);
    const change = p.expire(LATER);
    expect(change.events.map((e) => e.eventType)).toEqual([PAYMENT_EXPIRED]);
    expect(p.status).toBe('expired');
    expect(p.expire(LATER).changed).toBe(false);
  });

  it('cancelar cierra un pago abierto sin evento y no toca uno capturado', () => {
    const open = newPayment();
    expect(open.cancel('Pedido cancelado', NOW)).toMatchObject({ changed: true, events: [] });
    expect(open.status).toBe('cancelled');

    const captured = newPayment();
    captured.capture({ source: 'x' }, NOW);
    expect(captured.cancel('Pedido cancelado').changed).toBe(false);
    expect(captured.status).toBe('captured');
  });

  it('transferencia: el comprobante la deja pendiente de verificación', () => {
    const p = newPayment({ method: 'transfer', provider: 'manual' });
    expect(p.submitTransferVoucher('payments/vouchers/k.pdf', NOW).record).toMatchObject({ eventType: 'voucher_submitted' });
    expect(p.status).toBe('pending');
    // En revisión no se reemplaza: el backoffice aprobaría un archivo distinto del que vio.
    expect(() => p.submitTransferVoucher('payments/vouchers/k2.pdf', NOW)).toThrow(VoucherUnderReviewError);
  });

  it('no acepta comprobante en un pago que no es transferencia', () => {
    expect(() => newPayment().submitTransferVoucher('k', NOW)).toThrow(InvalidPaymentTransitionError);
  });
});
