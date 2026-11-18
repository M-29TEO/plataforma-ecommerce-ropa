import { DomainEvent } from '../../../shared-kernel';
import type { ReturnLineAmount, ReturnProps } from './return';

export const RETURN_REQUESTED = 'ReturnRequested';
export const RETURN_APPROVED = 'ReturnApproved';
export const RETURN_REJECTED = 'ReturnRejected';
export const RETURN_RECEIVED = 'ReturnReceived';
export const RETURN_INSPECTED = 'ReturnInspected';
export const RETURN_REFUNDED = 'ReturnRefunded';
export const RETURN_EXCHANGED = 'ReturnExchanged';

const AGGREGATE_TYPE = 'sales.return';

export interface ReturnItemPayload {
  returnItemId: string;
  orderItemId: string;
  variantId: string;
  sku: string;
  quantity: number;
  reasonCode: string;
  condition: string | null;
  restock: boolean | null;
  exchangeVariantId: string | null;
  /** Valor pagado de las unidades devueltas (IVA incluido). */
  total: string;
}

/**
 * Payload común de los eventos de una devolución. Consumidores previstos: Notificaciones (avisar
 * al cliente en cada paso) y Reportes. Los efectos en Logística, Inventario y Pagos los coordina
 * el orquestador de posventa en la misma transacción; Facturación emite la nota de crédito al
 * confirmarse el reembolso (RefundSucceeded).
 */
export interface ReturnEventPayload {
  returnId: string;
  orderId: string;
  orderNumber: string;
  rmaNumber: string;
  userId: string | null;
  customerEmail: string;
  type: string;
  status: string;
  resolution: string;
  refundAmount: string | null;
  actorId: string | null;
  /** Solo en ReturnRejected. */
  rejectionReason?: string;
  items: ReturnItemPayload[];
}

export interface ReturnEventContext {
  orderNumber: string;
  userId: string | null;
  customerEmail: string;
  lines: ReturnLineAmount[];
  variants: ReadonlyMap<string, { variantId: string; sku: string }>;
}

export function returnEvent(
  eventType: string,
  r: ReturnProps,
  ctx: ReturnEventContext,
  extra: { actorId?: string | null; rejectionReason?: string } = {},
): DomainEvent {
  const payload: ReturnEventPayload = {
    returnId: r.id,
    orderId: r.orderId,
    orderNumber: ctx.orderNumber,
    rmaNumber: r.rmaNumber,
    userId: ctx.userId,
    customerEmail: ctx.customerEmail,
    type: r.type,
    status: r.status,
    resolution: r.resolution,
    refundAmount: r.refundAmount,
    actorId: extra.actorId ?? null,
    ...(extra.rejectionReason ? { rejectionReason: extra.rejectionReason } : {}),
    items: r.items.map((i, n) => ({
      returnItemId: i.id,
      orderItemId: i.orderItemId,
      variantId: ctx.variants.get(i.orderItemId)?.variantId ?? '',
      sku: ctx.variants.get(i.orderItemId)?.sku ?? '',
      quantity: i.quantity,
      reasonCode: i.reasonCode,
      condition: i.condition,
      restock: i.restock,
      exchangeVariantId: i.exchangeVariantId,
      total: ctx.lines[n]?.total ?? '0.00',
    })),
  };
  return { tenantId: r.tenantId, aggregateType: AGGREGATE_TYPE, aggregateId: r.id, eventType, payload: { ...payload } };
}
