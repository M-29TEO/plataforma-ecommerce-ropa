import { InvalidRefundError, InvalidRefundTransitionError, RefundApprovalError } from './errors';
import { NewRefund, Refund, refundMethodFor } from './refund';

const THRESHOLD = 100_00; // $100.00
const T0 = new Date('2026-10-01T15:00:00Z');

function refund(overrides: Partial<NewRefund> = {}): Refund {
  return Refund.request(
    {
      tenantId: 't',
      paymentId: 'pay-1',
      orderId: 'ord-1',
      returnId: 'ret-1',
      amount: '45.00',
      method: 'original',
      reason: 'Devolución RMA-100045-1',
      requestedBy: 'u-bodega',
      ...overrides,
    },
    T0,
  );
}

describe('refundMethodFor', () => {
  it('saldo a favor → gift card; dinero de vuelta → pasarela, gift card o transferencia según el pago', () => {
    expect(refundMethodFor('store_credit', 'card')).toBe('gift_card');
    expect(refundMethodFor('refund_original', 'card')).toBe('original');
    expect(refundMethodFor('refund_original', 'deuna')).toBe('original');
    expect(refundMethodFor('refund_original', 'gift_card')).toBe('original');
    expect(refundMethodFor('refund_original', 'cod')).toBe('transfer');
    expect(refundMethodFor('refund_original', 'transfer')).toBe('transfer');
  });
});

describe('aprobación', () => {
  it('hasta $100 (inclusive) basta una aprobación', () => {
    const r = refund({ amount: '100.00' });
    expect(r.requiredApprovals(THRESHOLD)).toBe(1);
    expect(r.approve('u-finanzas', THRESHOLD)).toBe('approved');
    expect(r.toJSON().approvedBy).toBe('u-finanzas');
  });

  it('por encima de $100 hacen falta dos personas distintas', () => {
    const r = refund({ amount: '100.01' });
    expect(r.requiredApprovals(THRESHOLD)).toBe(2);
    expect(r.approve('u-finanzas', THRESHOLD)).toBe('first_approval');
    expect(r.toJSON()).toMatchObject({ status: 'pending', approvedBy: null });
    expect(() => r.approve('u-finanzas', THRESHOLD)).toThrow(expect.objectContaining({ code: 'REFUND_SECOND_APPROVER_REQUIRED' }));
    expect(r.approve('u-gerente', THRESHOLD)).toBe('approved');
    expect(r.toJSON().approvals.map((a) => a.userId)).toEqual(['u-finanzas', 'u-gerente']);
    expect(r.toJSON().approvedBy).toBe('u-gerente');
  });

  it('quien lo solicitó no puede aprobarlo', () => {
    expect(() => refund().approve('u-bodega', THRESHOLD)).toThrow(RefundApprovalError);
  });

  it('solo se aprueba un reembolso pendiente', () => {
    const r = refund();
    r.approve('u-finanzas', THRESHOLD);
    r.startProcessing(r.planFor({ paymentMethod: 'card', paymentAmount: '45.00', externalRefundedCents: 0 }));
    expect(() => r.approve('u-gerente', THRESHOLD)).toThrow(InvalidRefundTransitionError);
  });

  it('monto y método válidos', () => {
    expect(() => refund({ amount: '0.00' })).toThrow(InvalidRefundError);
    expect(() => refund({ method: 'cheque' as never })).toThrow(InvalidRefundError);
  });
});

describe('plan de ejecución', () => {
  it('pasarela por lo cobrado; lo pagado con gift card vuelve a esas tarjetas', () => {
    const r = refund({ amount: '45.00' });
    expect(r.planFor({ paymentMethod: 'card', paymentAmount: '100.00', externalRefundedCents: 0 })).toEqual({
      external: { kind: 'gateway', amount: '45.00' },
      giftCards: '0.00',
      storeCredit: '0.00',
    });
    // Pago con tarjeta de $30 (el resto del pedido se pagó con gift card) y $0 ya reembolsados.
    expect(r.planFor({ paymentMethod: 'card', paymentAmount: '30.00', externalRefundedCents: 0 })).toEqual({
      external: { kind: 'gateway', amount: '30.00' },
      giftCards: '15.00',
      storeCredit: '0.00',
    });
    // Otro reembolso ya devolvió $20 de los $30 cobrados.
    expect(r.planFor({ paymentMethod: 'card', paymentAmount: '30.00', externalRefundedCents: 20_00 })).toMatchObject({
      external: { kind: 'gateway', amount: '10.00' },
      giftCards: '35.00',
    });
  });

  it('pagado con gift card → todo a las gift cards; saldo a favor → gift card nueva; efectivo → transferencia', () => {
    expect(refund().planFor({ paymentMethod: 'gift_card', paymentAmount: '45.00', externalRefundedCents: 0 })).toEqual({
      external: null,
      giftCards: '45.00',
      storeCredit: '0.00',
    });
    expect(refund({ method: 'gift_card' }).planFor({ paymentMethod: 'card', paymentAmount: '45.00', externalRefundedCents: 0 })).toEqual({
      external: null,
      giftCards: '0.00',
      storeCredit: '45.00',
    });
    expect(refund({ method: 'transfer' }).planFor({ paymentMethod: 'cod', paymentAmount: '45.00', externalRefundedCents: 0 })).toEqual({
      external: { kind: 'transfer', amount: '45.00' },
      giftCards: '0.00',
      storeCredit: '0.00',
    });
  });

  it('un pago que no fue en línea no se reversa por la pasarela', () => {
    expect(() => refund().planFor({ paymentMethod: 'cod', paymentAmount: '45.00', externalRefundedCents: 0 })).toThrow(
      expect.objectContaining({ code: 'REFUND_METHOD_MISMATCH' }),
    );
  });
});

describe('ejecución por partes', () => {
  function processing(paymentAmount = '30.00') {
    const r = refund();
    r.approve('u-finanzas', THRESHOLD);
    r.startProcessing(r.planFor({ paymentMethod: 'card', paymentAmount, externalRefundedCents: 0 }));
    return r;
  }

  it('succeeded cuando se completan todas las partes; repetir una parte no hace nada', () => {
    const r = processing();
    expect(r.pendingParts()).toEqual(['external', 'gift_cards']);
    expect(r.completePart('gift_cards', 'gift_cards:15.00', T0)).toEqual({ changed: true, completed: false });
    expect(r.completePart('gift_cards', 'otra', T0)).toEqual({ changed: false, completed: false });
    expect(r.status).toBe('processing');
    const done = new Date('2026-10-01T15:05:00Z');
    expect(r.completePart('external', 'rf_123', done)).toEqual({ changed: true, completed: true });
    expect(r.toJSON()).toMatchObject({ status: 'succeeded', providerRef: 'rf_123', completedAt: done });
    expect(r.externalCents()).toBe(30_00);
  });

  it('una parte fuera del plan se rechaza; la falla solo desde processing', () => {
    const r = processing('45.00');
    expect(() => r.completePart('store_credit', 'x')).toThrow(expect.objectContaining({ code: 'REFUND_PART_NOT_PLANNED' }));
    expect(r.fail('CARD_EXPIRED: tarjeta vencida')).toBe(true);
    expect(r.fail('otra vez')).toBe(false);
    expect(r.toJSON()).toMatchObject({ status: 'failed', failureReason: 'CARD_EXPIRED: tarjeta vencida' });
    expect(() => refund().fail('x')).toThrow(InvalidRefundTransitionError);
  });
});
