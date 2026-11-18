import { DomainEvent } from '../../../shared-kernel';

export const RIDER_RATED = 'RiderRated';
export const CUSTOMER_RATED = 'CustomerRated';
export const RIDER_SETTLEMENT_DRAFTED = 'RiderSettlementDrafted';
export const RIDER_SETTLEMENT_APPROVED = 'RiderSettlementApproved';
export const RIDER_SETTLEMENT_DISPUTED = 'RiderSettlementDisputed';
export const RIDER_SETTLEMENT_PAID = 'RiderSettlementPaid';
export const RIDER_COD_LIMIT_EXCEEDED = 'RiderCodLimitExceeded';

/** Consumidores previstos: Reportes (ranking de motorizados), Notificaciones (alerta si score <= 2). */
export interface RiderRatedPayload {
  shipmentId: string;
  orderId: string;
  riderId: string;
  customerId: string;
  score: number;
  tags: string[];
  ratingAvg: string;
  ratingCount: number;
}

/** Consumidores previstos: CRM (risk_score y bloqueo de contra entrega del cliente). */
export interface CustomerRatedPayload {
  shipmentId: string;
  orderId: string;
  riderId: string;
  customerId: string;
  score: number;
  tags: string[];
  customerRatingAvg: string;
  customerRatingCount: number;
}

export interface RiderSettlementPayload {
  settlementId: string;
  riderId: string;
  periodStart: string;
  periodEnd: string;
  deliveriesCount: number;
  grossFees: string;
  bonuses: string;
  deductions: string;
  codCollected: string;
  codRemitted: string;
  netPayable: string;
  status: string;
}

/** Consumidores previstos: Notificaciones (avisar al backoffice y al motorizado). */
export interface RiderCodLimitExceededPayload {
  riderId: string;
  codBalance: string;
  codLimit: string;
  detectedAt: string;
}

export function riderRated(tenantId: string, ratingId: string, payload: RiderRatedPayload): DomainEvent {
  return { tenantId, aggregateType: 'logistics.rating', aggregateId: ratingId, eventType: RIDER_RATED, payload: { ...payload } };
}

export function customerRated(tenantId: string, ratingId: string, payload: CustomerRatedPayload): DomainEvent {
  return { tenantId, aggregateType: 'logistics.rating', aggregateId: ratingId, eventType: CUSTOMER_RATED, payload: { ...payload } };
}

export function riderSettlementEvent(
  tenantId: string,
  eventType: string,
  payload: RiderSettlementPayload & Record<string, unknown>,
): DomainEvent {
  return { tenantId, aggregateType: 'logistics.rider_settlement', aggregateId: payload.settlementId, eventType, payload: { ...payload } };
}

export function riderCodLimitExceeded(tenantId: string, payload: RiderCodLimitExceededPayload): DomainEvent {
  return { tenantId, aggregateType: 'logistics.rider', aggregateId: payload.riderId, eventType: RIDER_COD_LIMIT_EXCEEDED, payload: { ...payload } };
}

export const SHIPMENT_STATUS_CHANGED = 'ShipmentStatusChanged';

/**
 * Consumidores: Notificaciones (avisos al cliente), Pedidos y Realtime (previstos). Se emite en la
 * misma transacción que cambia logistics.shipments.status. Hoy lo emiten la cancelación de envíos
 * pendientes y la recepción de un retiro en bodega; el despacho (asignación de motorizado, webhooks
 * del courier) lo emitirá con este mismo contrato.
 */
export interface ShipmentStatusChangedPayload {
  shipmentId: string;
  orderId: string;
  returnId: string | null;
  direction: 'outbound' | 'return' | 'exchange';
  carrierType: string;
  previousStatus: string;
  status: string;
  /** Token del enlace público de seguimiento (/seguimiento/<token>). */
  trackingToken: string;
  description: string | null;
  occurredAt: string;
}

export function shipmentStatusChanged(tenantId: string, payload: ShipmentStatusChangedPayload): DomainEvent {
  return { tenantId, aggregateType: 'logistics.shipment', aggregateId: payload.shipmentId, eventType: SHIPMENT_STATUS_CHANGED, payload: { ...payload } };
}
