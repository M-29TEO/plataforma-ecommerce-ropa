import { InvalidOrderError, InvalidReturnError, InvalidReturnTransitionError, ReturnNotAllowedError } from './errors';
import { Actor, NewOrder, Order, OrderProps } from './order';
import { OrderStatus } from './order-status';
import { NewReturn, Return, returnLineAmount } from './return';

const staff: Actor = { type: 'staff', id: 'u-bodega' };
const T0 = new Date('2026-09-01T15:00:00Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);

function newOrder(overrides: Partial<NewOrder> = {}): NewOrder {
  return {
    tenantId: 't',
    userId: 'u-cliente',
    customer: { name: 'María Loor', email: 'maria@example.test' },
    billing: { idType: '05', idNumber: '1710034065' },
    paymentMethod: 'card',
    fulfillmentType: 'rider',
    shippingAddress: { mainStreet: 'Av. Amazonas', city: 'Quito' },
    shippingTotal: '3.00',
    items: [
      // 3 × 20.00 − 1.00 = 59.00 + IVA 15 % 8.85
      { variantId: 'v-blusa-m', productId: 'p-blusa', sku: 'BLU-M', productName: 'Blusa lino', sizeCode: 'M', quantity: 3, unitPrice: '20.00', discount: '1.00', taxCode: '4', taxRate: '15.00' },
      // 30.00, IVA 0 %
      { variantId: 'v-bolso', productId: 'p-bolso', sku: 'BOL', productName: 'Bolso', quantity: 1, unitPrice: '30.00', taxCode: '0', taxRate: '0' },
    ],
    ...overrides,
  };
}

/** Pedido entregado el día 0 (con número asignado, como lo devuelve el repositorio). */
function delivered(overrides: Partial<NewOrder> = {}): Order {
  const o = Order.place(newOrder(overrides), at(-3));
  o.assignNumber('100045');
  const path: OrderStatus[] = ['paid', 'preparing', 'shipped', 'in_transit'];
  path.forEach((to, i) => o.transitionTo(to, staff, null, at(-3 + i * 0.1)));
  o.transitionTo('delivered', staff, null, T0);
  return o;
}

const blusa = (o: OrderProps) => o.items.find((i) => i.sku === 'BLU-M')!;
const bolso = (o: OrderProps) => o.items.find((i) => i.sku === 'BOL')!;

function request(order: OrderProps, input: Partial<NewReturn> = {}, ctx: { open?: Map<string, number>; now?: Date; photosOptional?: boolean } = {}): Return {
  return Return.request(
    {
      tenantId: 't',
      orderId: order.id,
      type: 'return',
      items: [{ orderItemId: blusa(order).id, quantity: 1, reasonCode: 'size_small' }],
      ...input,
    },
    { order, openQuantities: ctx.open ?? new Map(), windowDays: 30, rmaNumber: 'RMA-100045-1', photosOptional: ctx.photosOptional, now: ctx.now ?? at(2) },
  );
}

describe('Return.request', () => {
  it('crea la solicitud en requested con motivo derivado, resolución y quién paga el retiro', () => {
    const order = delivered().toJSON();
    const r = request(order).toJSON();
    expect(r).toMatchObject({
      status: 'requested',
      type: 'return',
      resolution: 'refund_original',
      reason: 'Talla pequeña',
      rmaNumber: 'RMA-100045-1',
      returnShippingPaidBy: 'customer',
      refundAmount: null,
    });
    expect(r.items[0]).toMatchObject({ orderItemId: blusa(order).id, quantity: 1, condition: null, restock: null, photos: [] });
  });

  it('un motivo imputable a la tienda exige foto y la tienda paga el retiro', () => {
    const order = delivered().toJSON();
    const items = [{ orderItemId: blusa(order).id, quantity: 1, reasonCode: 'defect' as const }];
    expect(() => request(order, { items })).toThrow(expect.objectContaining({ code: 'PHOTO_REQUIRED' }));
    const r = request(order, { items: [{ ...items[0], photos: ['returns/photos/t/u/1.jpg'] }] }).toJSON();
    expect(r.returnShippingPaidBy).toBe('store');
    expect(r.items[0].photos).toEqual(['returns/photos/t/u/1.jpg']);
  });

  it('registrada por soporte, la falla de la tienda no exige foto (se verifica en la inspección)', () => {
    const order = delivered().toJSON();
    const items = [{ orderItemId: blusa(order).id, quantity: 1, reasonCode: 'defect' as const }];
    expect(request(order, { items }, { photosOptional: true }).toJSON()).toMatchObject({ status: 'requested', returnShippingPaidBy: 'store' });
  });

  it('solo pedidos entregados y dentro del plazo', () => {
    const notDelivered = Order.place(newOrder(), T0).toJSON();
    expect(() => request(notDelivered)).toThrow(expect.objectContaining({ code: 'ORDER_NOT_RETURNABLE' }));
    const order = delivered().toJSON();
    expect(() => request(order, {}, { now: at(30) })).not.toThrow();
    expect(() => request(order, {}, { now: at(31) })).toThrow(ReturnNotAllowedError);
  });

  it('no deja devolver más unidades que las compradas menos las devueltas y las ya solicitadas', () => {
    const order = delivered().toJSON();
    const id = blusa(order).id;
    expect(() => request(order, { items: [{ orderItemId: id, quantity: 4, reasonCode: 'other' }] })).toThrow(
      expect.objectContaining({ code: 'RETURN_QUANTITY_EXCEEDED' }),
    );
    expect(() => request(order, { items: [{ orderItemId: id, quantity: 2, reasonCode: 'other' }] }, { open: new Map([[id, 2]]) })).toThrow(
      expect.objectContaining({ code: 'RETURN_QUANTITY_EXCEEDED', details: { orderItemId: id, requested: 2, available: 1 } }),
    );
  });

  it('valida líneas: del pedido, sin repetir, con motivo conocido', () => {
    const order = delivered().toJSON();
    const id = blusa(order).id;
    expect(() => request(order, { items: [] })).toThrow(expect.objectContaining({ code: 'EMPTY_RETURN' }));
    expect(() => request(order, { items: [{ orderItemId: 'otro', quantity: 1, reasonCode: 'other' }] })).toThrow(
      expect.objectContaining({ code: 'ORDER_ITEM_NOT_FOUND' }),
    );
    expect(() =>
      request(order, { items: [{ orderItemId: id, quantity: 1, reasonCode: 'other' }, { orderItemId: id, quantity: 1, reasonCode: 'other' }] }),
    ).toThrow(expect.objectContaining({ code: 'DUPLICATE_ITEM' }));
    expect(() => request(order, { items: [{ orderItemId: id, quantity: 1, reasonCode: 'x' as never }] })).toThrow(InvalidReturnError);
  });

  it('cambio: exige otra variante; una devolución no la admite', () => {
    const order = delivered().toJSON();
    const id = blusa(order).id;
    expect(() => request(order, { type: 'exchange', items: [{ orderItemId: id, quantity: 1, reasonCode: 'size_small' }] })).toThrow(
      expect.objectContaining({ code: 'EXCHANGE_VARIANT_REQUIRED' }),
    );
    expect(() =>
      request(order, { type: 'exchange', items: [{ orderItemId: id, quantity: 1, reasonCode: 'size_small', exchangeVariantId: 'v-blusa-m' }] }),
    ).toThrow(expect.objectContaining({ code: 'SAME_VARIANT' }));
    expect(() => request(order, { items: [{ orderItemId: id, quantity: 1, reasonCode: 'size_small', exchangeVariantId: 'v-blusa-l' }] })).toThrow(
      expect.objectContaining({ code: 'EXCHANGE_VARIANT_NOT_ALLOWED' }),
    );
    const r = request(order, {
      type: 'exchange',
      resolution: 'store_credit',
      items: [{ orderItemId: id, quantity: 1, reasonCode: 'size_small', exchangeVariantId: 'v-blusa-l' }],
    }).toJSON();
    expect(r).toMatchObject({ type: 'exchange', resolution: 'exchange' });
  });
});

describe('returnLineAmount', () => {
  it('prorratea el descuento por unidad y calcula el IVA sobre la base', () => {
    const line = blusa(delivered().toJSON()); // 3 × 20.00 − 1.00
    expect(returnLineAmount(line, 1)).toMatchObject({ discount: '0.33', taxBase: '19.67', taxAmount: '2.95', total: '22.62' });
    expect(returnLineAmount(line, 3)).toMatchObject({ discount: '1.00', taxBase: '59.00', taxAmount: '8.85', total: '67.85' });
    expect(returnLineAmount(bolso(delivered().toJSON()), 1)).toMatchObject({ taxBase: '30.00', taxAmount: '0.00', total: '30.00' });
  });
});

describe('ciclo de vida', () => {
  function received(input: Partial<NewReturn> = {}) {
    const order = delivered().toJSON();
    const r = request(order, input);
    r.approve('u-aprueba');
    r.schedulePickup();
    r.receive();
    return { r, order };
  }

  it('requested → approved → pickup_scheduled (idempotente) → received', () => {
    const order = delivered().toJSON();
    const r = request(order);
    r.approve('u-aprueba');
    expect(r.toJSON()).toMatchObject({ status: 'approved', approvedBy: 'u-aprueba' });
    expect(r.schedulePickup()).toBe(true);
    expect(r.schedulePickup()).toBe(false);
    r.receive();
    expect(r.status).toBe('received');
    expect(received().r.status).toBe('received');
  });

  it('la inspección fija condición, reingreso y el monto a reembolsar', () => {
    const order = delivered().toJSON();
    const r = request(order, {
      items: [
        { orderItemId: blusa(order).id, quantity: 2, reasonCode: 'size_small' },
        { orderItemId: bolso(order).id, quantity: 1, reasonCode: 'changed_mind' },
      ],
    });
    r.approve('u-aprueba');
    r.receive(); // entrega en tienda: sin retiro programado
    const [b, o] = r.toJSON().items;
    const lines = r.inspect(
      [
        { returnItemId: b.id, condition: 'new', restock: true },
        { returnItemId: o.id, condition: 'damaged', restock: false },
      ],
      order,
      at(5),
    );
    // Blusa: 2 × 20.00 − 0.67 = 39.33 + 5.90 = 45.23 · Bolso 30.00
    expect(lines.map((l) => l.total)).toEqual(['45.23', '30.00']);
    expect(r.toJSON()).toMatchObject({ status: 'inspected', refundAmount: '75.23', closedAt: null });
    expect(r.toJSON().items.map((i) => [i.condition, i.restock])).toEqual([
      ['new', true],
      ['damaged', false],
    ]);
    expect(r.markRefunded(at(6))).toBe(true);
    expect(r.markRefunded(at(7))).toBe(false); // idempotente
    expect(r.toJSON()).toMatchObject({ status: 'refunded', closedAt: at(6) });
  });

  it('inspección: todas las líneas, sin repetir, y una unidad dañada no vuelve al stock', () => {
    const { r, order } = received();
    const item = r.toJSON().items[0];
    expect(() => r.inspect([], order)).toThrow(expect.objectContaining({ code: 'INSPECTION_INCOMPLETE' }));
    expect(() => r.inspect([{ returnItemId: item.id, condition: 'damaged', restock: true }], order)).toThrow(
      expect.objectContaining({ code: 'DAMAGED_NOT_RESTOCKABLE' }),
    );
    expect(r.status).toBe('received');
  });

  it('transiciones inválidas y rechazo con motivo', () => {
    const order = delivered().toJSON();
    const r = request(order);
    expect(() => r.receive()).toThrow(InvalidReturnTransitionError);
    expect(() => r.reject('  ')).toThrow(expect.objectContaining({ code: 'REASON_REQUIRED' }));
    expect(r.reject('Fuera de política', at(3))).toBe('Fuera de política');
    expect(r.toJSON()).toMatchObject({ status: 'rejected', closedAt: at(3) });
    expect(() => r.approve('u')).toThrow(InvalidReturnTransitionError);
  });

  it('un cambio termina en exchanged, nunca en refunded', () => {
    const order = delivered().toJSON();
    const r = request(order, {
      type: 'exchange',
      items: [{ orderItemId: blusa(order).id, quantity: 1, reasonCode: 'size_small', exchangeVariantId: 'v-blusa-l' }],
    });
    r.approve('u');
    r.receive();
    r.inspect([{ returnItemId: r.toJSON().items[0].id, condition: 'new', restock: true }], order);
    expect(r.toJSON().refundAmount).toBeNull();
    expect(() => r.markRefunded()).toThrow(InvalidReturnTransitionError);
    expect(r.markExchanged(at(9))).toBe(true);
    expect(r.toJSON()).toMatchObject({ status: 'exchanged', closedAt: at(9) });
  });
});

describe('Order.applyReturn y recordRefund', () => {
  it('parcial → partially_returned; el resto → returned, con historial y qty_returned', () => {
    const o = delivered();
    const p = o.toJSON();
    const first = o.applyReturn([{ orderItemId: blusa(p).id, quantity: 2 }], 'RMA-100045-1', staff, at(5));
    expect(first?.change).toMatchObject({ fromStatus: 'delivered', toStatus: 'partially_returned', reason: 'Devolución RMA-100045-1' });
    expect(blusa(o.toJSON()).qtyReturned).toBe(2);

    const again = o.applyReturn([{ orderItemId: bolso(p).id, quantity: 1 }], 'RMA-100045-2', staff, at(6));
    expect(again).toBeNull(); // sigue parcialmente devuelto: sin transición
    const last = o.applyReturn([{ orderItemId: blusa(p).id, quantity: 1 }], 'RMA-100045-3', staff, at(7));
    expect(last?.change).toMatchObject({ fromStatus: 'partially_returned', toStatus: 'returned' });
    expect(o.status).toBe('returned');
  });

  it('no permite devolver más de lo comprado', () => {
    const o = delivered();
    expect(() => o.applyReturn([{ orderItemId: blusa(o.toJSON()).id, quantity: 4 }], 'RMA', staff)).toThrow(InvalidOrderError);
    expect(blusa(o.toJSON()).qtyReturned).toBe(0);
  });

  it('payment_status: refunded solo cuando se devolvió el valor de toda la mercadería (sin envío)', () => {
    const o = delivered(); // total 100.85 = 67.85 + 30.00 + 3.00 de envío
    expect(o.toJSON().total).toBe('100.85');
    expect(o.recordRefund('22.62')).toBe(true);
    expect(o.paymentStatus).toBe('partially_refunded');
    expect(o.recordRefund('50.00')).toBe(false);
    expect(o.recordRefund('97.85')).toBe(true);
    expect(o.paymentStatus).toBe('refunded');
  });
});
