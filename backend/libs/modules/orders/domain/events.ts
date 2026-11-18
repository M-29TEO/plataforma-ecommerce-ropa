import { DomainEvent } from '../../../shared-kernel';
import type { OrderProps } from './order';
import type { OrderStatus } from './order-status';

export const ORDER_PLACED = 'OrderPlaced';
export const ORDER_PAID = 'OrderPaid';
export const ORDER_CANCELLED = 'OrderCancelled';
export const ORDER_DELIVERED = 'OrderDelivered';

const AGGREGATE_TYPE = 'sales.order';

export interface OrderLinePayload {
  orderItemId: string;
  variantId: string;
  warehouseId: string | null;
  sku: string;
  quantity: number;
}

/** Consumidores: Inventario (confirmar reserva si es COD), Notificaciones, Logística. */
export interface OrderPlacedPayload {
  orderId: string;
  orderNumber: string;
  userId: string | null;
  customerEmail: string;
  paymentMethod: string;
  paymentStatus: string;
  fulfillmentType: string;
  sourceWarehouseId: string | null;
  currency: string;
  total: string;
  placedAt: string;
  items: OrderLinePayload[];
}

/** Consumidores: Facturación SRI, Logística, Fidelización. En COD se emite al entregar. */
export interface OrderPaidPayload {
  orderId: string;
  orderNumber: string;
  userId: string | null;
  paymentMethod: string;
  currency: string;
  total: string;
  paidAt: string;
}

/**
 * Consumidores: Inventario (liberar reserva o reponer si ya se consumió), Pagos (reembolso
 * si paymentStatus = 'paid'), Notificaciones, Logística.
 */
export interface OrderCancelledPayload {
  orderId: string;
  orderNumber: string;
  userId: string | null;
  previousStatus: OrderStatus;
  paymentMethod: string;
  paymentStatus: string;
  reason: string;
  cancelledBy: string;
  cancelledAt: string;
  total: string;
  items: OrderLinePayload[];
}

/** Consumidores: Fidelización, Liquidaciones, solicitud de reseña. */
export interface OrderDeliveredPayload {
  orderId: string;
  orderNumber: string;
  userId: string | null;
  fulfillmentType: string;
  paymentMethod: string;
  total: string;
  deliveredAt: string;
}

function lines(o: OrderProps): OrderLinePayload[] {
  return o.items.map((i) => ({
    orderItemId: i.id,
    variantId: i.variantId,
    warehouseId: i.warehouseId,
    sku: i.sku,
    quantity: i.quantity,
  }));
}

function event(o: OrderProps, eventType: string, payload: object): DomainEvent {
  return { tenantId: o.tenantId, aggregateType: AGGREGATE_TYPE, aggregateId: o.id, eventType, payload: { ...payload } };
}

export function orderPlaced(o: OrderProps): DomainEvent {
  const payload: OrderPlacedPayload = {
    orderId: o.id,
    orderNumber: o.orderNumber!,
    userId: o.userId,
    customerEmail: o.customer.email,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    fulfillmentType: o.fulfillmentType,
    sourceWarehouseId: o.sourceWarehouseId,
    currency: o.currency,
    total: o.total,
    placedAt: o.placedAt.toISOString(),
    items: lines(o),
  };
  return event(o, ORDER_PLACED, payload);
}

export function orderPaid(o: OrderProps): DomainEvent {
  const payload: OrderPaidPayload = {
    orderId: o.id,
    orderNumber: o.orderNumber!,
    userId: o.userId,
    paymentMethod: o.paymentMethod,
    currency: o.currency,
    total: o.total,
    paidAt: o.paidAt!.toISOString(),
  };
  return event(o, ORDER_PAID, payload);
}

export function orderCancelled(o: OrderProps, previousStatus: OrderStatus, reason: string, cancelledBy: string): DomainEvent {
  const payload: OrderCancelledPayload = {
    orderId: o.id,
    orderNumber: o.orderNumber!,
    userId: o.userId,
    previousStatus,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    reason,
    cancelledBy,
    cancelledAt: o.cancelledAt!.toISOString(),
    total: o.total,
    items: lines(o),
  };
  return event(o, ORDER_CANCELLED, payload);
}

export function orderDelivered(o: OrderProps): DomainEvent {
  const payload: OrderDeliveredPayload = {
    orderId: o.id,
    orderNumber: o.orderNumber!,
    userId: o.userId,
    fulfillmentType: o.fulfillmentType,
    paymentMethod: o.paymentMethod,
    total: o.total,
    deliveredAt: o.deliveredAt!.toISOString(),
  };
  return event(o, ORDER_DELIVERED, payload);
}
