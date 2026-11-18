import { describe, expect, it } from 'vitest';
import {
  addressLines,
  availableTransitions,
  canTransition,
  dateRangeQuery,
  ORDER_STATUS,
  ORDER_STATUSES,
  PAYMENT_STATUS,
  PAYMENT_STATUSES,
  PERMISSION_FOR,
} from './orders';

const ALL = ['orders.status.update', 'orders.payment.confirm', 'orders.cancel'];
const card = { paymentMethod: 'card', fulfillmentType: 'rider' } as const;
const cod = { paymentMethod: 'cod', fulfillmentType: 'rider' } as const;
const pickup = { paymentMethod: 'card', fulfillmentType: 'pickup' } as const;

const targets = (o: Parameters<typeof availableTransitions>[0], perms = ALL, type?: 'staff' | 'rider' | 'customer') =>
  availableTransitions(o, perms, type).map((t) => t.to);

describe('máquina de estados (réplica del backend)', () => {
  it('condiciones de COD y retiro en tienda', () => {
    expect(canTransition('created', 'paid', card)).toBe(true);
    expect(canTransition('created', 'paid', cod)).toBe(false);
    expect(canTransition('created', 'preparing', cod)).toBe(true);
    expect(canTransition('created', 'preparing', card)).toBe(false);
    expect(canTransition('preparing', 'shipped', pickup)).toBe(false);
    expect(canTransition('preparing', 'delivered', pickup)).toBe(true);
    expect(canTransition('preparing', 'delivered', card)).toBe(false);
    expect(canTransition('shipped', 'cancelled', card)).toBe(false);
  });

  it('ofrece solo transiciones válidas para el pedido', () => {
    expect(targets({ status: 'created', ...card })).toEqual(['paid', 'cancelled']);
    expect(targets({ status: 'created', ...cod })).toEqual(['preparing', 'cancelled']);
    expect(targets({ status: 'paid', ...card })).toEqual(['preparing', 'cancelled']);
    expect(targets({ status: 'preparing', ...card })).toEqual(['shipped', 'cancelled']);
    expect(targets({ status: 'preparing', ...pickup })).toEqual(['delivered', 'cancelled']);
    expect(targets({ status: 'shipped', ...card })).toEqual(['in_transit']);
    expect(targets({ status: 'in_transit', ...card })).toEqual(['delivered']);
  });

  it('nunca ofrece las devoluciones ni nada desde estados finales', () => {
    expect(targets({ status: 'delivered', ...card })).toEqual([]);
    expect(targets({ status: 'partially_returned', ...card })).toEqual([]);
    expect(targets({ status: 'cancelled', ...card })).toEqual([]);
    expect(targets({ status: 'returned', ...card })).toEqual([]);
  });

  it('filtra por el permiso del estado destino', () => {
    expect(PERMISSION_FOR.paid).toBe('orders.payment.confirm');
    expect(PERMISSION_FOR.cancelled).toBe('orders.cancel');
    expect(targets({ status: 'created', ...card }, ['orders.status.update'])).toEqual([]);
    expect(targets({ status: 'created', ...card }, ['orders.payment.confirm'])).toEqual(['paid']);
    expect(targets({ status: 'paid', ...card }, ['orders.status.update'])).toEqual(['preparing']);
    expect(targets({ status: 'paid', ...card }, ['orders.cancel'])).toEqual(['cancelled']);
  });

  it('motorizado: solo en camino / entregado; cliente: nada', () => {
    expect(targets({ status: 'preparing', ...card }, ALL, 'rider')).toEqual([]);
    expect(targets({ status: 'shipped', ...card }, ALL, 'rider')).toEqual(['in_transit']);
    expect(targets({ status: 'created', ...card }, ALL, 'customer')).toEqual([]);
  });

  it('cancelar exige motivo y se marca como peligroso', () => {
    const cancel = availableTransitions({ status: 'paid', ...card }, ALL).find((t) => t.to === 'cancelled');
    expect(cancel).toMatchObject({ reasonRequired: true, danger: true });
  });
});

describe('etiquetas', () => {
  it('todos los estados de pedido y de pago tienen texto en español', () => {
    for (const s of ORDER_STATUSES) expect(ORDER_STATUS[s][0]).toBeTruthy();
    for (const s of PAYMENT_STATUSES) expect(PAYMENT_STATUS[s][0]).toBeTruthy();
    expect(ORDER_STATUS.in_transit[0]).toBe('En camino');
    expect(PAYMENT_STATUS.cod_pending[0]).toBe('Contra entrega');
  });
});

describe('filtros y presentación', () => {
  it('rango de fechas en hora de Ecuador, "hasta" inclusivo', () => {
    expect(dateRangeQuery('2026-10-01', '2026-10-07')).toEqual({
      from: '2026-10-01T05:00:00.000Z',
      to: '2026-10-08T05:00:00.000Z',
    });
    expect(dateRangeQuery('', '')).toEqual({});
  });

  it('dirección legible sin vacíos ni coordenadas', () => {
    expect(addressLines({ mainStreet: 'Av. Amazonas', number: 'N34', reference: '', lat: -0.18, city: 'Quito' })).toEqual([
      ['Calle principal', 'Av. Amazonas'],
      ['Número', 'N34'],
      ['Ciudad', 'Quito'],
    ]);
    expect(addressLines(null)).toEqual([]);
  });
});
