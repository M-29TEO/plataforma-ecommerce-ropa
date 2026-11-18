import { Queryable } from '../../../shared-kernel';
import { GeoPoint } from '../domain/geo';

/**
 * Entrega de la bodega a logística al terminar el picking (orquestador fulfillment). Solo el
 * schema logistics: el envío de despacho vigente de cada pedido y el envío de retiro en tienda.
 */
export interface OutboundShipmentInfo {
  shipmentId: string;
  orderId: string;
  carrierType: string;
  status: string;
  /** Franja reservada en el checkout (solo motorizado). */
  slot: { startsAt: Date; endsAt: Date } | null;
}

/** Retiro en tienda: el checkout no crea envío; se crea al terminar el picking, ya listo para retirar. */
export interface NewPickupShipment {
  tenantId: string;
  orderId: string;
  trackingToken: string;
  warehouseId: string;
  /** La tienda de retiro (dirección y nombre), para la vista de seguimiento. */
  destination: Record<string, unknown>;
  location: GeoPoint;
  codAmount: string;
  description: string;
}

export abstract class HandoffRepository {
  /** Serializa las entregas de un mismo pedido (dos "terminar picking" a la vez no crean dos envíos). */
  abstract lockOrder(q: Queryable, orderId: string): Promise<void>;
  /** Último envío de despacho (outbound) no cancelado de cada pedido. Los pedidos sin envío no aparecen. */
  abstract listOutbound(q: Queryable, tenantId: string, orderIds: string[]): Promise<OutboundShipmentInfo[]>;
  /** Inserta el envío 'pickup' en estado ready_for_pickup con su primer evento. Devuelve el id. */
  abstract insertPickupReady(q: Queryable, s: NewPickupShipment): Promise<string>;
}
