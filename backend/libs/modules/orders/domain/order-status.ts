import { InvalidOrderTransitionError } from './errors';

/** Estados del pedido (mismos valores que el CHECK de sales.orders.status). */
export const ORDER_STATUSES = [
  'created',
  'paid',
  'preparing',
  'shipped',
  'in_transit',
  'delivered',
  'cancelled',
  'partially_returned',
  'returned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const FULFILLMENT_TYPES = ['rider', 'courier', 'pickup'] as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

/** Mismos métodos que payments.payments.method. 'cod' = contra entrega. */
export const PAYMENT_METHODS = ['card', 'deuna', 'pichincha', 'transfer', 'qr', 'cod', 'gift_card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Máquina de estados del pedido (tabla explícita: lo que no está aquí se rechaza).
 *
 *   created ──pago──▶ paid ──▶ preparing ──▶ shipped ──▶ in_transit ──▶ delivered ──▶ partially_returned
 *      │                │         ▲  │                                    ▲    │               │
 *      └──── COD ───────┼─────────┘  └──────── pickup (retiro en tienda) ─┘    └──▶ returned ◀─┘
 *      │                │            │
 *      └────────────────┴────────────┴──▶ cancelled
 *
 * Las condiciones (COD, pickup) se verifican en GUARDS. partially_returned y returned solo los
 * alcanza el flujo de devoluciones (Order.applyReturn), que también actualiza qty_returned.
 */
export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  created: ['paid', 'preparing', 'cancelled'],
  paid: ['preparing', 'cancelled'],
  preparing: ['shipped', 'delivered', 'cancelled'],
  shipped: ['in_transit'],
  in_transit: ['delivered'],
  delivered: ['partially_returned', 'returned'],
  cancelled: [],
  partially_returned: ['returned'],
  returned: [],
};

/** Estados que exigen motivo (quedan en cancel_reason / order_status_history.reason). */
export const REASON_REQUIRED: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['cancelled', 'partially_returned', 'returned']);

/**
 * Estados que el backoffice puede fijar a mano (POST /orders/:id/status). Las devoluciones no:
 * las registra el flujo de devoluciones junto con las cantidades devueltas y el reembolso.
 */
export const MANUAL_STATUSES = ORDER_STATUSES.filter((s) => s !== 'partially_returned' && s !== 'returned');
export type ManualOrderStatus = Exclude<OrderStatus, 'partially_returned' | 'returned'>;

export interface TransitionContext {
  paymentMethod: PaymentMethod;
  fulfillmentType: FulfillmentType;
}

type Guard = (ctx: TransitionContext) => string | null;

const isCod = (ctx: TransitionContext) => ctx.paymentMethod === 'cod';
const isPickup = (ctx: TransitionContext) => ctx.fulfillmentType === 'pickup';

/** Condiciones por transición. Devuelven el motivo del rechazo o null si se permite. */
const GUARDS: Partial<Record<`${OrderStatus}->${OrderStatus}`, Guard>> = {
  // Un pedido contra entrega se cobra al entregarlo, no antes.
  'created->paid': (ctx) => (isCod(ctx) ? 'Un pedido contra entrega se cobra al entregarlo' : null),
  // Solo contra entrega pasa a preparación sin pago.
  'created->preparing': (ctx) => (isCod(ctx) ? null : 'El pedido debe estar pagado antes de prepararlo'),
  // Retiro en tienda: no hay despacho; se entrega en mostrador.
  'preparing->shipped': (ctx) => (isPickup(ctx) ? 'Un pedido de retiro en tienda no se despacha' : null),
  'preparing->delivered': (ctx) => (isPickup(ctx) ? null : 'Solo un pedido de retiro en tienda se entrega sin despacho'),
};

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

/** true si la transición está en la tabla y cumple su condición. */
export function canTransition(from: OrderStatus, to: OrderStatus, ctx: TransitionContext): boolean {
  return TRANSITIONS[from].includes(to) && (GUARDS[`${from}->${to}`]?.(ctx) ?? null) === null;
}

/** Lanza InvalidOrderTransitionError si from → to no está permitida para este pedido. */
export function assertTransition(from: OrderStatus, to: OrderStatus, ctx: TransitionContext): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidOrderTransitionError(from, to, `No existe la transición de "${from}" a "${to}"`);
  }
  const rejection = GUARDS[`${from}->${to}`]?.(ctx) ?? null;
  if (rejection) throw new InvalidOrderTransitionError(from, to, rejection);
}
