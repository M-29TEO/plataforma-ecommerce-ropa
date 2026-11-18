import { InvalidOrderTransitionError } from './errors';
import {
  assertTransition,
  canTransition,
  FulfillmentType,
  MANUAL_STATUSES,
  ORDER_STATUSES,
  OrderStatus,
  PaymentMethod,
  TransitionContext,
  TRANSITIONS,
} from './order-status';

const PREPAID: TransitionContext = { paymentMethod: 'card', fulfillmentType: 'rider' };
const COD: TransitionContext = { paymentMethod: 'cod', fulfillmentType: 'rider' };
const PICKUP: TransitionContext = { paymentMethod: 'card', fulfillmentType: 'pickup' };
const PICKUP_COD: TransitionContext = { paymentMethod: 'cod', fulfillmentType: 'pickup' };

/**
 * Transiciones válidas esperadas y el contexto en el que valen. Es la especificación: si
 * alguien cambia TRANSITIONS sin actualizar esta lista, los tests fallan.
 */
const VALID: [OrderStatus, OrderStatus, TransitionContext][] = [
  ['created', 'paid', PREPAID],
  ['created', 'preparing', COD],
  ['created', 'cancelled', PREPAID],
  ['created', 'cancelled', COD],
  ['paid', 'preparing', PREPAID],
  ['paid', 'cancelled', PREPAID],
  ['preparing', 'shipped', PREPAID],
  ['preparing', 'shipped', COD],
  ['preparing', 'delivered', PICKUP],
  ['preparing', 'delivered', PICKUP_COD],
  ['preparing', 'cancelled', PREPAID],
  ['preparing', 'cancelled', COD],
  ['shipped', 'in_transit', PREPAID],
  ['in_transit', 'delivered', PREPAID],
  ['in_transit', 'delivered', COD],
  ['delivered', 'returned', PREPAID],
  ['delivered', 'returned', COD],
  ['delivered', 'partially_returned', PREPAID],
  ['delivered', 'partially_returned', COD],
  ['partially_returned', 'returned', PREPAID],
  ['partially_returned', 'returned', PICKUP],
];

/** Transiciones que existen en la tabla pero que su condición rechaza en ese contexto. */
const GUARDED: [OrderStatus, OrderStatus, TransitionContext, RegExp][] = [
  ['created', 'paid', COD, /contra entrega/],
  ['created', 'preparing', PREPAID, /pagado/],
  ['created', 'preparing', PICKUP, /pagado/],
  ['preparing', 'shipped', PICKUP, /retiro en tienda/],
  ['preparing', 'shipped', PICKUP_COD, /retiro en tienda/],
  ['preparing', 'delivered', PREPAID, /retiro en tienda/],
  ['preparing', 'delivered', COD, /retiro en tienda/],
];

const inTable = new Set(Object.entries(TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`)));
const ALL_PAIRS = ORDER_STATUSES.flatMap((from) => ORDER_STATUSES.map((to) => [from, to] as [OrderStatus, OrderStatus]));
const NOT_IN_TABLE = ALL_PAIRS.filter(([from, to]) => !inTable.has(`${from}->${to}`));
const CONTEXTS: [PaymentMethod, FulfillmentType][] = [
  ['card', 'rider'],
  ['cod', 'rider'],
  ['transfer', 'courier'],
  ['cod', 'courier'],
  ['card', 'pickup'],
  ['cod', 'pickup'],
];

describe('Máquina de estados del pedido', () => {
  it('la tabla contiene exactamente las transiciones especificadas', () => {
    const expected = new Set([...VALID, ...GUARDED].map(([f, t]) => `${f}->${t}`));
    expect([...inTable].sort()).toEqual([...expected].sort());
  });

  describe('transiciones válidas', () => {
    it.each(VALID)('%s → %s (%o)', (from, to, ctx) => {
      expect(canTransition(from, to, ctx)).toBe(true);
      expect(() => assertTransition(from, to, ctx)).not.toThrow();
    });
  });

  describe('transiciones rechazadas por su condición', () => {
    it.each(GUARDED)('%s → %s (%o)', (from, to, ctx, message) => {
      expect(canTransition(from, to, ctx)).toBe(false);
      expect(() => assertTransition(from, to, ctx)).toThrow(InvalidOrderTransitionError);
      expect(() => assertTransition(from, to, ctx)).toThrow(message);
    });
  });

  describe(`transiciones inexistentes (${NOT_IN_TABLE.length} parejas × ${CONTEXTS.length} contextos)`, () => {
    it.each(NOT_IN_TABLE)('%s → %s se rechaza siempre', (from, to) => {
      for (const [paymentMethod, fulfillmentType] of CONTEXTS) {
        const ctx = { paymentMethod, fulfillmentType };
        expect(canTransition(from, to, ctx)).toBe(false);
        let error: unknown;
        try {
          assertTransition(from, to, ctx);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(InvalidOrderTransitionError);
        expect((error as InvalidOrderTransitionError).code).toBe('INVALID_ORDER_TRANSITION');
        expect((error as InvalidOrderTransitionError).details).toEqual({ from, to });
      }
    });
  });

  it('cancelled y returned son estados finales', () => {
    expect(TRANSITIONS.cancelled).toEqual([]);
    expect(TRANSITIONS.returned).toEqual([]);
  });

  it('el backoffice no fija a mano los estados de devolución', () => {
    expect(MANUAL_STATUSES).not.toContain('returned');
    expect(MANUAL_STATUSES).not.toContain('partially_returned');
    expect(MANUAL_STATUSES).toContain('delivered');
  });

  it('no se puede cancelar después de despachar', () => {
    for (const from of ['shipped', 'in_transit', 'delivered'] as const) {
      expect(canTransition(from, 'cancelled', PREPAID)).toBe(false);
    }
  });
});
