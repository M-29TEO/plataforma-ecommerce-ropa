import type { CartView } from '../../cart';
import type { PaymentCreated } from '../../payments';
import { assistedPaymentTtlSeconds, assistedPaymentView, assistedTotals, customerSnapshot, displayName, gatewayMethod } from './assisted-order';

describe('pedidos asistidos (dominio)', () => {
  it('card_link se cobra como tarjeta en la pasarela; transferencia y contra entrega no cambian', () => {
    expect(gatewayMethod('card_link')).toBe('card');
    expect(gatewayMethod('transfer')).toBe('transfer');
    expect(gatewayMethod('cod')).toBe('cod');
  });

  it('plazo del pago: enlace con ASSISTED_PAYMENT_LINK_TTL_MINUTES; transferencia, el mayor de los dos; cod no vence', () => {
    const config = { assistedLinkTtlMinutes: 1440, transferTtlHours: 12 };
    expect(assistedPaymentTtlSeconds('card_link', config)).toBe(24 * 3600);
    expect(assistedPaymentTtlSeconds('transfer', config)).toBe(24 * 3600);
    expect(assistedPaymentTtlSeconds('transfer', { assistedLinkTtlMinutes: 60, transferTtlHours: 12 })).toBe(12 * 3600);
    expect(assistedPaymentTtlSeconds('cod', config)).toBeNull();
  });

  it('nombre visible: nombre y apellido, o el email si la cuenta no tiene nombre', () => {
    expect(displayName(' Ana ', 'Pérez', 'a@x.ec')).toBe('Ana Pérez');
    expect(displayName(null, null, 'a@x.ec')).toBe('a@x.ec');
  });

  describe('customerSnapshot', () => {
    const registered = {
      userId: 'u1',
      email: 'Ana@X.ec',
      firstName: 'Ana',
      lastName: 'Pérez',
      phone: '0991234567',
      idType: '05',
      idNumber: '1710034065',
      status: 'active' as const,
    };

    it('copia contacto e identificación completa (email en minúsculas)', () => {
      expect(customerSnapshot(registered)).toEqual({ name: 'Ana Pérez', email: 'ana@x.ec', phone: '0991234567', idType: '05', idNumber: '1710034065' });
    });

    it('sin tipo de identificación no copia el número (consumidor final)', () => {
      expect(customerSnapshot({ ...registered, idType: null, phone: null })).toEqual({ name: 'Ana Pérez', email: 'ana@x.ec' });
    });

    it('invitado', () => {
      expect(customerSnapshot({ email: 'b@x.ec', firstName: 'Luis', lastName: 'Mora', phone: '0987654321' })).toEqual({
        name: 'Luis Mora',
        email: 'b@x.ec',
        phone: '0987654321',
      });
    });

    it('un cliente bloqueado no compra: 422 CUSTOMER_BLOCKED', () => {
      expect(() => customerSnapshot({ ...registered, status: 'blocked' })).toThrow(expect.objectContaining({ code: 'CUSTOMER_BLOCKED' }));
    });
  });

  it('totales: mercadería con IVA + envío menos su descuento (igual que el checkout)', () => {
    const cart = {
      totals: { itemCount: 2, subtotal: '40.00', discountTotal: '4.00', taxableBase: '36.00', taxTotal: '5.40', total: '41.40' },
      shippingDiscount: '1.00',
    } as CartView;
    expect(assistedTotals(cart, '3.00')).toEqual({ subtotal: '40.00', discountTotal: '4.00', shippingTotal: '2.00', taxTotal: '5.40', total: '43.40' });
    expect(assistedTotals({ ...cart, shippingDiscount: '0.00' }, '0.00').total).toBe('41.40');
  });

  describe('assistedPaymentView', () => {
    const payment = {
      id: '11111111-1111-1111-1111-111111111111',
      orderId: 'o1',
      method: 'card',
      status: 'pending',
      amount: '26.00',
      currency: 'USD',
      expiresAt: null,
      capturedAt: null,
      cardBrand: null,
      cardLast4: null,
      failureCode: null,
      failureMessage: null,
    } as PaymentCreated['payment'];

    it('card_link: la URL de la pasarela para enviar al cliente', () => {
      const view = assistedPaymentView('card_link', { payment, clientSecret: 's', nextAction: { type: 'redirect', url: 'http://paysim/pay?x=1' } });
      expect(view).toMatchObject({ id: payment.id, method: 'card_link', status: 'pending', paymentUrl: 'http://paysim/pay?x=1', clientSecret: 's' });
      expect(view.transfer).toBeUndefined();
    });

    it('transferencia: cuenta, referencia y dónde subir el comprobante', () => {
      const view = assistedPaymentView('transfer', {
        payment: { ...payment, method: 'transfer' },
        clientSecret: 's',
        nextAction: { type: 'bank_transfer', account: 'Banco X 123', reference: 'PAGO-11111111', expiresAt: null },
      });
      expect(view.paymentUrl).toBeUndefined();
      expect(view.transfer).toEqual({
        account: 'Banco X 123',
        reference: 'PAGO-11111111',
        expiresAt: null,
        voucherUploadPath: `/v1/payments/${payment.id}/transfer/voucher`,
      });
    });
  });
});
