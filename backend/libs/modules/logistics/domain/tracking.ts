import { ConflictError, ValidationError } from '../../../shared-kernel';
import { GeoPoint, haversineMeters, ROAD_DETOUR_FACTOR } from './geo';

/**
 * Entrega con motorizado, de la asignación a la entrega. El envío llega al motorizado por el
 * despacho automático (oferta que acepta: 'accepted', ver domain/dispatch.ts) o por asignación
 * manual del backoffice ('assigned'); luego el motorizado avanza los estados desde su app (o el
 * simulador, npm run sim:rider). 'failed_attempt': no pudo entregar y reintenta (vuelve a in_transit).
 */
export const RIDER_ACTIVE_STATUSES = ['assigned', 'accepted', 'picked_up', 'in_transit', 'arriving', 'failed_attempt'] as const;
/** Estados en que el motorizado ya lleva el paquete: se publica su posición al cliente. */
export const LIVE_TRACKING_STATUSES = ['picked_up', 'in_transit', 'arriving'] as const;
export const RIDER_SETTABLE_STATUSES = ['picked_up', 'in_transit', 'arriving', 'failed_attempt'] as const;
export type RiderSettableStatus = (typeof RIDER_SETTABLE_STATUSES)[number];

const SHIPMENT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  // ready_for_pickup: la bodega terminó el picking (orquestador fulfillment); el motorizado lo retira después.
  // accepted: el motorizado aceptó la oferta del despacho automático (equivale a assigned).
  pending: ['assigned', 'accepted', 'ready_for_pickup'],
  ready_for_pickup: ['assigned', 'accepted'],
  assigned: ['assigned', 'picked_up'],
  accepted: ['assigned', 'picked_up'],
  picked_up: ['in_transit'],
  in_transit: ['arriving', 'delivered', 'failed_attempt'],
  arriving: ['delivered', 'failed_attempt'],
  // Intento fallido (nadie en casa, dirección errada...): el motorizado reintenta.
  failed_attempt: ['in_transit'],
};

/** Descripción que ve el cliente en la línea de tiempo del seguimiento. */
export const STATUS_DESCRIPTIONS: Readonly<Record<string, string>> = {
  pending: 'Pedido recibido',
  ready_for_pickup: 'Tu pedido está empacado y listo para salir',
  assigned: 'Motorizado asignado',
  accepted: 'Motorizado asignado',
  picked_up: 'El motorizado retiró tu pedido',
  in_transit: 'En camino',
  arriving: 'El motorizado está llegando',
  failed_attempt: 'No pudimos entregar tu pedido; lo intentaremos de nuevo',
  delivered: 'Entregado',
  cancelled: 'Envío cancelado',
};

/** Distancia máxima al destino para marcar una entrega (el GPS de un teléfono en la calle). */
export const MAX_DELIVERY_DISTANCE_M = 300;
/** Una posición más vieja que esto no se muestra como "en vivo". */
export const LIVE_POSITION_MAX_AGE_MS = 15 * 60 * 1000;
/** Velocidad media de un motorizado en ciudad, para el ETA sin OSRM. */
export const FALLBACK_SPEED_KMH = 22;

export class ShipmentTransitionError extends ConflictError {
  constructor(from: string, to: string) {
    super('SHIPMENT_INVALID_TRANSITION', `El envío no puede pasar de ${from} a ${to}`, { from, to });
  }
}

export class NotRiderShipmentError extends ValidationError {
  constructor(shipmentId: string) {
    super('SHIPMENT_NOT_RIDER', 'Solo los envíos con motorizado se asignan y se siguen en vivo', { shipmentId });
  }
}

export class TooFarFromDestinationError extends ValidationError {
  constructor(distanceM: number) {
    super('DELIVERY_TOO_FAR', `Estás a ${distanceM} m del destino: acércate a menos de ${MAX_DELIVERY_DISTANCE_M} m para entregar`, {
      distanceM,
      maxDistanceM: MAX_DELIVERY_DISTANCE_M,
    });
  }
}

export class StalePositionError extends ValidationError {
  constructor() {
    super('POSITION_OUT_OF_RANGE', 'La hora de la posición está fuera de rango (más de 1 hora atrás o en el futuro)');
  }
}

export function assertShipmentTransition(from: string, to: string): void {
  if (!(SHIPMENT_TRANSITIONS[from] ?? []).includes(to)) throw new ShipmentTransitionError(from, to);
}

/**
 * Pasos del pedido (Pedidos) que acompañan a un estado del envío, desde el estado actual del
 * pedido. Asignar = en preparación; retirar = despachado; en camino = en tránsito; entregar =
 * entregado. Devuelve [] si el pedido ya está ahí o más adelante (los reintentos no fallan).
 */
const ORDER_CHAIN = ['preparing', 'shipped', 'in_transit', 'delivered'] as const;
type OrderStep = (typeof ORDER_CHAIN)[number];
const ORDER_TARGET: Readonly<Record<string, OrderStep>> = {
  assigned: 'preparing',
  accepted: 'preparing',
  picked_up: 'shipped',
  in_transit: 'in_transit',
  arriving: 'in_transit',
  delivered: 'delivered',
};

export function orderStepsFor(shipmentStatus: string, orderStatus: string): OrderStep[] {
  const target = ORDER_TARGET[shipmentStatus];
  if (!target) return [];
  const targetIdx = ORDER_CHAIN.indexOf(target);
  let currentIdx: number;
  if (orderStatus === 'created' || orderStatus === 'paid') currentIdx = -1;
  else if ((ORDER_CHAIN as readonly string[]).includes(orderStatus)) currentIdx = ORDER_CHAIN.indexOf(orderStatus as OrderStep);
  else if (orderStatus === 'partially_returned' || orderStatus === 'returned') return [];
  else throw new ConflictError('ORDER_NOT_DELIVERABLE', `El pedido está ${orderStatus}: no se puede despachar`, { orderStatus });
  return ORDER_CHAIN.slice(currentIdx + 1, targetIdx + 1) as OrderStep[];
}

/** ETA sin OSRM: distancia en línea recta por el factor de desvío, a velocidad de ciudad. */
export function fallbackEtaSeconds(from: GeoPoint, to: GeoPoint, speedKmh = FALLBACK_SPEED_KMH): number {
  const meters = haversineMeters(from, to) * ROAD_DETOUR_FACTOR;
  return Math.round(meters / ((speedKmh * 1000) / 3600));
}

/** La posición informada no puede venir del futuro (1 min de tolerancia) ni tener más de 1 hora. */
export function assertRecentPosition(recordedAt: Date, now: Date): void {
  const delta = now.getTime() - recordedAt.getTime();
  if (delta < -60_000 || delta > 60 * 60_000) throw new StalePositionError();
}

export function isLive(status: string): boolean {
  return (LIVE_TRACKING_STATUSES as readonly string[]).includes(status);
}

/** Sala de Socket.IO del pedido (ADR-07) y sus eventos: contrato con apps/realtime y el storefront. */
export const orderRoom = (orderId: string) => `order:${orderId}`;
export const REALTIME_EVENTS = { location: 'rider.location', status: 'shipment.status' } as const;

/**
 * Backoffice (mapa en vivo y despacho): namespace `/staff` de Socket.IO, sala `riders:{tenantId}`.
 * Separado del namespace público para que un token de seguimiento nunca reciba datos de staff.
 */
export const STAFF_NAMESPACE = '/staff';
export const ridersRoom = (tenantId: string) => `riders:${tenantId}`;
export const STAFF_EVENTS = { location: 'rider.location', status: 'shipment.status', presence: 'rider.presence', offer: 'dispatch.offer' } as const;

/** Estados de presencia que el motorizado puede fijar desde su app ('busy': recibe ofertas solo bajo su tope de envíos). */
export const RIDER_PRESENCES = ['offline', 'available', 'busy', 'break'] as const;
export type RiderPresence = (typeof RIDER_PRESENCES)[number];
