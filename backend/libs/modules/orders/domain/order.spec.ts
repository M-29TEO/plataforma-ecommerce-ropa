import { ValidationError } from '../../../shared-kernel';
import {
  CustomerCannotTransitionError,
  InvalidOrderError,
  InvalidOrderTransitionError,
  ReasonRequiredError,
} from './errors';
import { ORDER_CANCELLED, ORDER_DELIVERED, ORDER_PAID } from './events';
import { Actor, NewOrder, Order } from './order';
import { OrderStatus } from './order-status';

const staff: Actor = { type: 'staff', id: 'u-staff' };
const system: Actor = { type: 'system', id: null };
const customer: Actor = { type: 'customer', id: 'u-cliente' };
const T0 = new Date('2026-09-29T15:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function input(overrides: Partial<NewOrder> = {}): NewOrder {
  return {
    tenantId: 't',
    userId: 'u-cliente',
    customer: { name: 'María Loor', email: 'Maria@Example.test ' },
    billing: { idType: '05', idNumber: '1712345678', name: 'María Loor' },
    paymentMethod: 'card',
    fulfillmentType: 'rider',
    shippingAddress: { mainStreet: 'Av. Amazonas', city: 'Quito' },
    shippingTotal: '3.50',
    items: [
      {
        variantId: 'v1',
        productId: 'p1',
        sku: 'CAM-NEG-M',
        productName: 'Camiseta básica',
        brandName: 'Andina',
        categoryPath: 'unisex/camisetas',
        colorName: 'Negro',
        sizeCode: 'M',
        quantity: 2,
        unitPrice: '14.90',
        discount: '2.00',
        taxCode: '4',
        taxRate: '15',
        unitCost: '6.10',
        warehouseId: 'w1',
      },
      {
        variantId: 'v2',
        productId: 'p2',
        sku: 'JEAN-AZ-32',
        productName: 'Jean slim',
        colorName: 'Azul',
        sizeCode: '32',
        quantity: 1,
        unitPrice: 39.99,
        taxCode: '4',
        taxRate: '15.00',
        unitCost: '18.00',
        warehouseId: 'w1',
      },
    ],
    ...overrides,
  };
}

/** Pedido ya persistido (con número y versión), como lo devuelve el repositorio. */
function placed(overrides: Partial<NewOrder> = {}): Order {
  const o = Order.place(input(overrides), T0);
  o.assignNumber('100001');
  return o;
}

/** Lleva el pedido por una secuencia de estados. */
function walk(o: Order, path: OrderStatus[]): Order {
  path.forEach((to, i) => o.transitionTo(to, staff, to === 'cancelled' || to === 'returned' || to === 'partially_returned' ? 'motivo' : null, at(i + 1)));
  return o;
}

describe('Order.place', () => {
  it('queda en created, con snapshots y totales calculados en centavos', () => {
    const o = placed().toJSON();
    expect(o.status).toBe('created');
    expect(o.paymentStatus).toBe('pending');
    expect(o.version).toBe(0);
    expect(o.customer.email).toBe('maria@example.test');

    const [camiseta, jean] = o.items;
    // (2 × 14.90 − 2.00) = 27.80; IVA 15 % = 4.17; línea = 31.97
    expect(camiseta).toMatchObject({
      sku: 'CAM-NEG-M',
      productName: 'Camiseta básica',
      brandName: 'Andina',
      categoryPath: 'unisex/camisetas',
      colorName: 'Negro',
      sizeCode: 'M',
      unitPrice: '14.90',
      discount: '2.00',
      taxRate: '15.00',
      taxAmount: '4.17',
      lineTotal: '31.97',
      unitCost: '6.10',
    });
    // 39.99 × 15 % = 5.9985 → 6.00 (mitad hacia arriba)
    expect(jean).toMatchObject({ unitPrice: '39.99', discount: '0.00', taxAmount: '6.00', lineTotal: '45.99', brandName: null });

    expect(o).toMatchObject({
      subtotal: '69.79',
      discountTotal: '2.00',
      taxTotal: '10.17',
      shippingTotal: '3.50',
      giftCardTotal: '0.00',
      total: '81.46', // 69.79 − 2.00 + 10.17 + 3.50
      costTotal: '30.20',
    });
  });

  it('contra entrega queda con payment_status cod_pending', () => {
    expect(placed({ paymentMethod: 'cod' }).paymentStatus).toBe('cod_pending');
  });

  it('la gift card se descuenta del total y no puede superarlo', () => {
    expect(placed({ giftCardTotal: '50' }).toJSON().total).toBe('31.46');
    expect(() => Order.place(input({ giftCardTotal: '81.47' }))).toThrow(InvalidOrderError);
  });

  it('costTotal es null si falta el costo de alguna línea', () => {
    const [a, b] = input().items;
    expect(placed({ items: [a, { ...b, unitCost: null }] }).toJSON().costTotal).toBeNull();
  });

  it.each<[string, Partial<NewOrder>, string]>([
    ['sin ítems', { items: [] }, 'EMPTY_ORDER'],
    ['sin email', { customer: { name: 'X', email: ' ' } }, 'INVALID_CUSTOMER'],
    ['envío sin dirección', { shippingAddress: null }, 'SHIPPING_ADDRESS_REQUIRED'],
    ['retiro sin tienda', { fulfillmentType: 'pickup', shippingAddress: null }, 'PICKUP_WAREHOUSE_REQUIRED'],
    ['método de pago desconocido', { paymentMethod: 'bitcoin' as never }, 'INVALID_PAYMENT_METHOD'],
    ['tipo de entrega desconocido', { fulfillmentType: 'drone' as never }, 'INVALID_FULFILLMENT_TYPE'],
  ])('rechaza pedido %s', (_name, overrides, code) => {
    expect(() => Order.place(input(overrides))).toThrow(expect.objectContaining({ code }));
  });

  it.each<[string, object, string]>([
    ['cantidad 0', { quantity: 0 }, 'INVALID_QUANTITY'],
    ['cantidad decimal', { quantity: 1.5 }, 'INVALID_QUANTITY'],
    ['sin SKU', { sku: '' }, 'INVALID_ITEM_SNAPSHOT'],
    ['sin nombre', { productName: ' ' }, 'INVALID_ITEM_SNAPSHOT'],
    ['descuento mayor a la línea', { discount: '29.81' }, 'DISCOUNT_EXCEEDS_LINE'],
    ['IVA > 100 %', { taxRate: '100.01' }, 'INVALID_TAX_RATE'],
    ['código de IVA inválido', { taxCode: 'IVA' }, 'INVALID_TAX_CODE'],
    ['precio con 3 decimales', { unitPrice: '1.999' }, 'INVALID_MONEY'],
  ])('rechaza ítem con %s', (_name, patch, code) => {
    const [a, b] = input().items;
    expect(() => Order.place(input({ items: [{ ...a, ...patch }, b] }))).toThrow(expect.objectContaining({ code }));
  });

  it('el historial inicial es null → created', () => {
    expect(placed().placedChange(customer)).toMatchObject({ fromStatus: null, toStatus: 'created', actorType: 'customer' });
  });
});

describe('Order.transitionTo · transiciones válidas', () => {
  it('created → paid: payment_status paid, paid_at y OrderPaid', () => {
    const o = placed();
    const r = o.transitionTo('paid', system, null, at(1));
    const p = o.toJSON();
    expect(p).toMatchObject({ status: 'paid', paymentStatus: 'paid', paidAt: at(1), updatedAt: at(1) });
    expect(r.change).toEqual({
      orderId: o.id,
      fromStatus: 'created',
      toStatus: 'paid',
      actorType: 'system',
      actorId: null,
      reason: null,
      createdAt: at(1),
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      tenantId: 't',
      aggregateType: 'sales.order',
      aggregateId: o.id,
      eventType: ORDER_PAID,
      payload: { orderId: o.id, orderNumber: '100001', total: '81.46', paymentMethod: 'card', paidAt: at(1).toISOString() },
    });
  });

  it('created → preparing (contra entrega, sin pago): sigue cod_pending y no emite eventos', () => {
    const o = placed({ paymentMethod: 'cod' });
    const r = o.transitionTo('preparing', staff, null, at(1));
    expect(o.toJSON()).toMatchObject({ status: 'preparing', paymentStatus: 'cod_pending', paidAt: null });
    expect(r.events).toEqual([]);
  });

  it('created → cancelled: guarda motivo, cancelled_at y OrderCancelled con las líneas', () => {
    const o = placed();
    const r = o.transitionTo('cancelled', customer, '  Me equivoqué de talla ', at(1));
    expect(o.toJSON()).toMatchObject({ status: 'cancelled', cancelReason: 'Me equivoqué de talla', cancelledAt: at(1) });
    expect(r.change).toMatchObject({ fromStatus: 'created', toStatus: 'cancelled', reason: 'Me equivoqué de talla', actorId: 'u-cliente' });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      eventType: ORDER_CANCELLED,
      payload: {
        previousStatus: 'created',
        paymentStatus: 'pending',
        reason: 'Me equivoqué de talla',
        cancelledBy: 'customer',
        items: [
          { variantId: 'v1', warehouseId: 'w1', quantity: 2, sku: 'CAM-NEG-M' },
          { variantId: 'v2', warehouseId: 'w1', quantity: 1, sku: 'JEAN-AZ-32' },
        ],
      },
    });
  });

  it('paid → preparing: sin eventos', () => {
    const o = walk(placed(), ['paid']);
    expect(o.transitionTo('preparing', staff, null, at(5)).events).toEqual([]);
    expect(o.status).toBe('preparing');
  });

  it('paid → cancelled: OrderCancelled indica que ya estaba pagado (Pagos reembolsa)', () => {
    const o = walk(placed(), ['paid']);
    const r = o.transitionTo('cancelled', staff, 'Sin stock físico', at(5));
    expect(r.events[0].payload).toMatchObject({ previousStatus: 'paid', paymentStatus: 'paid', cancelledBy: 'staff' });
  });

  it('preparing → shipped: shipped_at', () => {
    const o = walk(placed(), ['paid', 'preparing']);
    const r = o.transitionTo('shipped', staff, null, at(5));
    expect(o.toJSON()).toMatchObject({ status: 'shipped', shippedAt: at(5) });
    expect(r.events).toEqual([]);
  });

  it('preparing → cancelled', () => {
    const o = walk(placed(), ['paid', 'preparing']);
    const r = o.transitionTo('cancelled', staff, 'Cliente no confirma', at(5));
    expect(o.status).toBe('cancelled');
    expect(r.events[0].payload).toMatchObject({ previousStatus: 'preparing' });
  });

  it('shipped → in_transit: sin eventos', () => {
    const o = walk(placed(), ['paid', 'preparing', 'shipped']);
    expect(o.transitionTo('in_transit', { type: 'rider', id: 'r1' }, null, at(5)).events).toEqual([]);
    expect(o.status).toBe('in_transit');
  });

  it('in_transit → delivered (prepagado): delivered_at y solo OrderDelivered', () => {
    const o = walk(placed(), ['paid', 'preparing', 'shipped', 'in_transit']);
    const r = o.transitionTo('delivered', { type: 'rider', id: 'r1' }, null, at(9));
    expect(o.toJSON()).toMatchObject({ status: 'delivered', deliveredAt: at(9), paidAt: at(1), paymentStatus: 'paid' });
    expect(r.events.map((e) => e.eventType)).toEqual([ORDER_DELIVERED]);
    expect(r.events[0].payload).toMatchObject({ deliveredAt: at(9).toISOString(), fulfillmentType: 'rider' });
  });

  it('in_transit → delivered (contra entrega): se cobra al entregar → OrderPaid + OrderDelivered', () => {
    const o = walk(placed({ paymentMethod: 'cod' }), ['preparing', 'shipped', 'in_transit']);
    const r = o.transitionTo('delivered', { type: 'rider', id: 'r1' }, null, at(9));
    expect(o.toJSON()).toMatchObject({ paymentStatus: 'paid', paidAt: at(9), deliveredAt: at(9) });
    expect(r.events.map((e) => e.eventType)).toEqual([ORDER_PAID, ORDER_DELIVERED]);
    expect(r.events[0].payload).toMatchObject({ paymentMethod: 'cod', paidAt: at(9).toISOString() });
  });

  it('preparing → delivered (retiro en tienda), sin shipped_at', () => {
    const o = walk(placed({ fulfillmentType: 'pickup', shippingAddress: null, sourceWarehouseId: 'w1' }), ['paid', 'preparing']);
    const r = o.transitionTo('delivered', staff, null, at(5));
    expect(o.toJSON()).toMatchObject({ status: 'delivered', shippedAt: null, deliveredAt: at(5) });
    expect(r.events.map((e) => e.eventType)).toEqual([ORDER_DELIVERED]);
  });

  it('delivered → returned: exige motivo y no emite eventos (los emite el flujo de devoluciones)', () => {
    const o = walk(placed(), ['paid', 'preparing', 'shipped', 'in_transit', 'delivered']);
    const r = o.transitionTo('returned', staff, 'Devolución total aprobada', at(20));
    expect(o.status).toBe('returned');
    expect(r.change).toMatchObject({ fromStatus: 'delivered', toStatus: 'returned', reason: 'Devolución total aprobada' });
    expect(r.events).toEqual([]);
  });
});

describe('Order.recordPaymentFailure', () => {
  it('un pago en línea fallido deja payment_status en failed y OrderCancelled lo informa', () => {
    const order = Order.place(input(), T0);
    order.recordPaymentFailure(at(1));
    const { events } = order.transitionTo('cancelled', system, 'Pago rechazado', at(1));
    expect(order.paymentStatus).toBe('failed');
    expect(events.find((e) => e.eventType === ORDER_CANCELLED)?.payload).toMatchObject({ paymentStatus: 'failed' });
  });

  it('no toca un pedido contra entrega ni uno ya pagado', () => {
    const cod = Order.place(input({ paymentMethod: 'cod' }), T0);
    cod.recordPaymentFailure();
    expect(cod.paymentStatus).toBe('cod_pending');

    const paid = Order.place(input(), T0);
    paid.transitionTo('paid', system, null, at(1));
    paid.recordPaymentFailure();
    expect(paid.paymentStatus).toBe('paid');
  });
});

describe('Order.transitionTo · transiciones inválidas', () => {
  /** Estado de partida → cómo llegar a él. */
  const reach: Record<OrderStatus, OrderStatus[]> = {
    created: [],
    paid: ['paid'],
    preparing: ['paid', 'preparing'],
    shipped: ['paid', 'preparing', 'shipped'],
    in_transit: ['paid', 'preparing', 'shipped', 'in_transit'],
    delivered: ['paid', 'preparing', 'shipped', 'in_transit', 'delivered'],
    cancelled: ['cancelled'],
    partially_returned: ['paid', 'preparing', 'shipped', 'in_transit', 'delivered', 'partially_returned'],
    returned: ['paid', 'preparing', 'shipped', 'in_transit', 'delivered', 'returned'],
  };
  const invalid: [OrderStatus, OrderStatus][] = [
    ['created', 'created'],
    ['created', 'shipped'],
    ['created', 'in_transit'],
    ['created', 'delivered'],
    ['created', 'returned'],
    ['paid', 'created'],
    ['paid', 'paid'],
    ['paid', 'shipped'],
    ['paid', 'delivered'],
    ['preparing', 'paid'],
    ['preparing', 'in_transit'],
    ['preparing', 'delivered'], // no es retiro en tienda
    ['shipped', 'delivered'],
    ['shipped', 'cancelled'],
    ['in_transit', 'shipped'],
    ['in_transit', 'cancelled'],
    ['delivered', 'cancelled'],
    ['delivered', 'in_transit'],
    ['cancelled', 'created'],
    ['cancelled', 'paid'],
    ['cancelled', 'preparing'],
    ['returned', 'delivered'],
    ['returned', 'cancelled'],
  ];

  it.each(invalid)('%s → %s lanza INVALID_ORDER_TRANSITION y no modifica el pedido', (from, to) => {
    const o = walk(placed(), reach[from]);
    const before = o.toJSON();
    expect(() => o.transitionTo(to, staff, 'motivo', at(30))).toThrow(InvalidOrderTransitionError);
    expect(o.toJSON()).toEqual(before);
  });

  it('created → paid se rechaza en contra entrega', () => {
    expect(() => placed({ paymentMethod: 'cod' }).transitionTo('paid', system)).toThrow(/contra entrega/);
  });

  it('created → preparing se rechaza si no está pagado y no es contra entrega', () => {
    expect(() => placed().transitionTo('preparing', staff)).toThrow(/pagado/);
  });

  it('preparing → shipped se rechaza en retiro en tienda', () => {
    const o = walk(placed({ fulfillmentType: 'pickup', shippingAddress: null, sourceWarehouseId: 'w1' }), ['paid', 'preparing']);
    expect(() => o.transitionTo('shipped', staff)).toThrow(InvalidOrderTransitionError);
  });

  it.each(['cancelled', 'returned'] as const)('%s sin motivo lanza REASON_REQUIRED', (to) => {
    const o = walk(placed(), to === 'returned' ? reach.delivered : []);
    expect(() => o.transitionTo(to, staff, '   ')).toThrow(ReasonRequiredError);
    expect(() => o.transitionTo(to, staff)).toThrow(ValidationError);
    expect(o.status).toBe(to === 'returned' ? 'delivered' : 'created');
  });

  it('el cliente solo puede cancelar en created o paid', () => {
    expect(() => walk(placed(), ['paid', 'preparing']).transitionTo('cancelled', customer, 'x')).toThrow(
      CustomerCannotTransitionError,
    );
    expect(() => walk(placed(), ['paid']).transitionTo('preparing', customer)).toThrow(CustomerCannotTransitionError);
    expect(() => placed().transitionTo('paid', customer)).toThrow(CustomerCannotTransitionError);
    expect(() => walk(placed(), ['paid']).transitionTo('cancelled', customer, 'Ya no lo necesito')).not.toThrow();
  });
});
