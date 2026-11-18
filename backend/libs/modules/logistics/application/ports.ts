/**
 * Puertos del módulo Logística. Persistencia (schema logistics) y servicios externos:
 * MapsPort (OSRM) y CourierPort (couriers; hoy el simulador, ADR-10).
 */
import { Queryable } from '../../../shared-kernel';
import { GeoPoint, MultiPolygon } from '../domain/geo';
import { NormalizedRating, RaterType } from '../domain/rating';
import { RateCard } from '../domain/rate-card';
import { SettleableDelivery, SettlementDraft, SettlementStatus } from '../domain/settlement';
import { DeliverySlot, NewDeliverySlot, SlotTemplate, SlotTemplateProps } from '../domain/slot';
import { CoverageZone, ZoneProps } from '../domain/zone';

// ---------------------------------------------------------------- Zonas
export interface ZoneFilter {
  active?: boolean;
  city?: string;
}

export abstract class ZoneRepository {
  abstract insert(q: Queryable, tenantId: string, z: ZoneProps): Promise<CoverageZone>;
  /** Reemplaza todas las columnas editables (el servicio ya aplicó el PATCH y validó). */
  abstract update(q: Queryable, tenantId: string, id: string, z: ZoneProps): Promise<CoverageZone | null>;
  abstract findById(q: Queryable, tenantId: string, id: string): Promise<CoverageZone | null>;
  abstract list(q: Queryable, tenantId: string, filter: ZoneFilter): Promise<CoverageZone[]>;
  /** ZoneResolver: zona activa que cubre el punto (ST_Covers); con superposición, la de menor priority. */
  abstract resolve(q: Queryable, tenantId: string, point: GeoPoint): Promise<CoverageZone | null>;
  /** Motivo de ST_IsValidReason si PostGIS considera inválida el área; null si es válida. */
  abstract areaProblem(q: Queryable, area: MultiPolygon): Promise<string | null>;
  /** Job de franjas: zonas activas con motorizado, de todos los tenants. */
  abstract listRiderZones(q: Queryable): Promise<{ tenantId: string; zoneId: string; sameDayCutoff: string | null }[]>;
}

// ---------------------------------------------------------------- Franjas
export abstract class SlotRepository {
  abstract insertTemplate(q: Queryable, zoneId: string, t: SlotTemplateProps): Promise<SlotTemplate>;
  abstract updateTemplate(q: Queryable, zoneId: string, id: string, t: SlotTemplateProps): Promise<SlotTemplate | null>;
  abstract findTemplate(q: Queryable, zoneId: string, id: string): Promise<SlotTemplate | null>;
  abstract deleteTemplate(q: Queryable, zoneId: string, id: string): Promise<boolean>;
  abstract listTemplates(q: Queryable, zoneId: string): Promise<SlotTemplate[]>;
  /** INSERT ... ON CONFLICT (zone_id, starts_at) DO NOTHING. Devuelve cuántas se crearon. */
  abstract insertSlots(q: Queryable, slots: NewDeliverySlot[]): Promise<number>;
  abstract listSlots(q: Queryable, zoneId: string, fromDate: string, toDate: string): Promise<DeliverySlot[]>;
  /** Con cupo y sin cerrar, que empiezan antes de `until`. */
  abstract listBookable(q: Queryable, zoneId: string, now: Date, until: Date): Promise<DeliverySlot[]>;
  abstract findSlot(q: Queryable, zoneId: string, id: string): Promise<DeliverySlot | null>;
  /** null si no existe; lanza si la capacidad queda bajo lo reservado (CHECK booked <= capacity). */
  abstract updateCapacity(q: Queryable, zoneId: string, id: string, capacity: number): Promise<DeliverySlot | null>;
  /** UPDATE condicional atómico: booked + 1 solo si queda cupo y no cerró. null si no se pudo. */
  abstract book(q: Queryable, zoneId: string, id: string, now: Date): Promise<DeliverySlot | null>;
  abstract release(q: Queryable, id: string): Promise<boolean>;
}

// ---------------------------------------------------------------- Couriers
export interface CourierServiceInfo {
  courierId: string;
  courierCode: string;
  courierName: string;
  /** Adaptador de CourierPort ('simulator', 'servientrega'...). */
  adapter: string;
  supportsCod: boolean;
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  maxWeightKg: number | null;
  slaHours: number | null;
}

export interface NewCourierQuote {
  quoteGroupId: string;
  courierServiceId: string;
  price: string;
  etaHours: number | null;
  source: 'api' | 'rate_card';
  rawResponse: unknown;
  validUntil: Date;
}

export interface CourierQuoteRecord extends NewCourierQuote {
  id: string;
  shipmentId: string | null;
  selected: boolean;
}

export abstract class CourierRepository {
  abstract listActiveServices(q: Queryable, tenantId: string): Promise<CourierServiceInfo[]>;
  abstract listRateCards(q: Queryable, serviceIds: string[]): Promise<RateCard[]>;
  abstract insertQuotes(q: Queryable, quotes: NewCourierQuote[]): Promise<string[]>;
  abstract findQuote(q: Queryable, tenantId: string, id: string): Promise<CourierQuoteRecord | null>;
  /** Marca la cotización elegida y la liga al envío. false si ya se usó para otro envío. */
  abstract markSelected(q: Queryable, id: string, shipmentId: string): Promise<boolean>;
}

// ---------------------------------------------------------------- Envíos
export interface NewPendingShipment {
  tenantId: string;
  orderId: string;
  carrierType: 'rider' | 'courier';
  courierServiceId: string | null;
  trackingToken: string;
  originWarehouseId: string;
  destination: Record<string, unknown>;
  destinationLocation: GeoPoint;
  zoneId: string | null;
  deliverySlotId: string | null;
  distanceM: number | null;
  weightG: number;
  volumeCm3: number | null;
  priceCharged: string;
  carrierCost: string | null;
  codAmount: string;
  eta: Date | null;
}

/** outbound: despacho del pedido · return: retiro de una devolución · exchange: envío de la talla nueva. */
export type ShipmentDirection = 'outbound' | 'return' | 'exchange';

export interface ShipmentSummary {
  id: string;
  orderId: string;
  returnId: string | null;
  direction: ShipmentDirection;
  carrierType: string;
  status: string;
  originWarehouseId: string | null;
  zoneId: string | null;
  deliverySlotId: string | null;
  courierServiceId: string | null;
  priceCharged: string;
  trackingToken: string;
  deliveredAt: Date | null;
}

/**
 * Envío de logística inversa de una devolución. En un retiro (return), destination es donde se
 * recoge el paquete (la dirección del cliente) y origin_warehouse_id la bodega que lo recibe; en
 * un cambio (exchange), como en un despacho normal, sale de origin_warehouse_id hacia destination.
 */
export interface NewReverseShipment {
  tenantId: string;
  orderId: string;
  returnId: string;
  direction: 'return' | 'exchange';
  carrierType: 'rider' | 'courier' | 'pickup';
  trackingToken: string;
  originWarehouseId: string;
  destination: Record<string, unknown>;
  destinationLocation: GeoPoint | null;
  weightG: number;
  items: { orderItemId: string; quantity: number }[];
  /** Texto del primer evento del envío (shipment_events). */
  description: string;
}

export interface CancelledShipment {
  id: string;
  deliverySlotId: string | null;
  carrierType: string;
  trackingToken: string;
}

export abstract class ShipmentRepository {
  /** Envío en estado 'pending' creado en el checkout (con su evento en shipment_events). */
  abstract insertPending(q: Queryable, s: NewPendingShipment): Promise<string>;
  abstract findByOrder(q: Queryable, tenantId: string, orderId: string): Promise<ShipmentSummary[]>;
  /**
   * Pedido cancelado: pasa a 'cancelled' SOLO los despachos 'pending' (idempotente: un evento
   * repetido no encuentra nada) y devuelve sus franjas para liberar el cupo.
   */
  abstract cancelPendingByOrder(q: Queryable, tenantId: string, orderId: string, reason: string): Promise<CancelledShipment[]>;
  /**
   * Envío 'pending' de una devolución, con sus ítems y su primer evento. null si la devolución ya
   * tiene un envío vigente en esa dirección (índice único ux_ship_return_direction).
   */
  abstract insertReverse(q: Queryable, s: NewReverseShipment): Promise<string | null>;
  abstract findByReturn(q: Queryable, tenantId: string, returnId: string, direction: 'return' | 'exchange'): Promise<ShipmentSummary | null>;
  /**
   * El retiro llegó a bodega: 'delivered' (con la bodega que lo recibió, si se indica) y su evento.
   * Idempotente: un retiro ya entregado se devuelve sin cambios. null si no existe.
   */
  abstract markReturnDelivered(q: Queryable, tenantId: string, returnId: string, warehouseId: string | null): Promise<ShipmentSummary | null>;
}

// ---------------------------------------------------------------- Motorizados
export interface RiderRecord {
  id: string;
  tenantId: string;
  userId: string;
  status: string;
  /** jsonb tal cual; lo interpreta domain/commission. */
  commissionScheme: unknown;
  codLimit: string;
  codBalance: string;
  ratingAvg: string;
  ratingCount: number;
}

export abstract class RiderRepository {
  abstract findById(q: Queryable, tenantId: string, id: string): Promise<RiderRecord | null>;
  abstract findByUser(q: Queryable, tenantId: string, userId: string): Promise<RiderRecord | null>;
  /** SELECT ... FOR UPDATE: serializa calificaciones, liquidaciones y movimientos de efectivo del motorizado. */
  abstract lock(q: Queryable, id: string): Promise<RiderRecord | null>;
  /** Recalcula rating_avg / rating_count desde logistics.ratings (llamar con la fila bloqueada). */
  abstract recomputeRating(q: Queryable, id: string): Promise<{ ratingAvg: string; ratingCount: number }>;
  abstract setCodBalance(q: Queryable, id: string, codBalance: string): Promise<void>;
}

// ---------------------------------------------------------------- Calificaciones
export interface RateableShipment {
  id: string;
  orderId: string;
  carrierType: string;
  status: string;
  riderId: string | null;
  riderUserId: string | null;
  deliveredAt: Date | null;
}

export interface NewRating extends NormalizedRating {
  shipmentId: string;
  raterType: RaterType;
  raterId: string;
  rateeId: string;
}

export interface RatingRecord extends NewRating {
  id: string;
  createdAt: Date;
}

export abstract class RatingRepository {
  abstract findShipment(q: Queryable, tenantId: string, shipmentId: string): Promise<RateableShipment | null>;
  /** ON CONFLICT (shipment_id, rater_type) DO NOTHING: null si ese lado ya calificó. */
  abstract insert(q: Queryable, r: NewRating): Promise<RatingRecord | null>;
  abstract list(q: Queryable, raterType: RaterType, rateeId: string, limit: number): Promise<RatingRecord[]>;
  /** Promedio de las calificaciones recibidas (no hay columna agregada para el cliente). */
  abstract summary(q: Queryable, raterType: RaterType, rateeId: string): Promise<{ ratingAvg: string | null; ratingCount: number }>;
}

// ---------------------------------------------------------------- Liquidaciones
export interface SettlementRecord {
  id: string;
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
  status: SettlementStatus;
  approvedBy: string | null;
  paidAt: Date | null;
}

export interface SettlementItemRecord {
  shipmentId: string;
  orderId: string;
  deliveredAt: Date | null;
  distanceM: number | null;
  codMethod: string | null;
  fee: string;
  codAmount: string;
}

export interface SettlementFilter {
  riderId?: string;
  status?: SettlementStatus;
  periodStart?: string;
  limit: number;
  offset: number;
}

export type SettlementUpdate = Partial<Pick<SettlementRecord, 'deductions' | 'codRemitted' | 'netPayable' | 'approvedBy'>> & {
  status: SettlementStatus;
  paid?: boolean;
};

export abstract class SettlementRepository {
  /** Motorizados con algo que liquidar al cierre: entregas sin liquidar, un borrador del período o efectivo sobre el límite. */
  abstract listRidersToSettle(
    q: Queryable,
    tenantId: string | null,
    period: { start: string; end: string },
    closeAt: Date,
  ): Promise<{ tenantId: string; riderId: string }[]>;
  abstract findForPeriod(q: Queryable, riderId: string, start: string, end: string): Promise<SettlementRecord | null>;
  /** Entregas con motorizado 'delivered' antes del cierre que no están en ninguna liquidación. */
  abstract listUnsettledDeliveries(q: Queryable, riderId: string, closeAt: Date): Promise<SettleableDelivery[]>;
  /** Inserta o reemplaza (el borrador que se recalcula) la cabecera y sus ítems. */
  abstract saveDraft(
    q: Queryable,
    riderId: string,
    period: { start: string; end: string },
    draft: SettlementDraft,
    existingId: string | null,
  ): Promise<SettlementRecord>;
  abstract deleteItems(q: Queryable, id: string): Promise<void>;
  abstract delete(q: Queryable, id: string): Promise<void>;
  abstract findById(q: Queryable, tenantId: string, id: string, opts?: { lock?: boolean }): Promise<SettlementRecord | null>;
  abstract listItems(q: Queryable, id: string): Promise<SettlementItemRecord[]>;
  abstract list(q: Queryable, tenantId: string, filter: SettlementFilter): Promise<SettlementRecord[]>;
  abstract update(q: Queryable, id: string, patch: SettlementUpdate): Promise<SettlementRecord>;
}

// ---------------------------------------------------------------- Servicios externos
export interface Route {
  distanceM: number;
  durationS: number;
}

/** Rutas por calle (OSRM). Lanza si no hay servicio o no encuentra ruta. */
export abstract class MapsPort {
  abstract route(from: GeoPoint, to: GeoPoint): Promise<Route>;
}

export interface Place {
  city: string;
  province: string;
}

export interface CourierQuoteRequest {
  origin: Place;
  destination: Place;
  weightKg: number;
  volumeCm3: number;
}

export interface CourierApiQuote {
  serviceCode: string;
  price: string;
  etaHours: number | null;
  raw: unknown;
}

export interface CourierShipmentRequest {
  reference: string;
  serviceCode: string;
  sender: Place & { name: string; address?: string; phone?: string };
  recipient: Place & { name: string; address: string; phone?: string };
  weightKg: number;
  volumeCm3: number;
  packages: number;
  codAmount: string;
}

export interface CourierShipmentResult {
  trackingNumber: string;
  status: string;
  price: string;
  raw: unknown;
}

/**
 * Puerto de un courier externo. Solo `quote` se usa en el checkout; `createShipment` y
 * `getLabel` los usará el despacho (siguiente paso) para generar la guía.
 */
export abstract class CourierPort {
  abstract readonly adapter: string;
  abstract quote(req: CourierQuoteRequest, signal: AbortSignal): Promise<CourierApiQuote[]>;
  abstract createShipment(req: CourierShipmentRequest, signal: AbortSignal): Promise<CourierShipmentResult>;
  abstract getLabel(trackingNumber: string, signal: AbortSignal): Promise<Buffer>;
}

/** Adaptadores habilitados por COURIER_ADAPTERS, por nombre (logistics.couriers.adapter). */
export abstract class CourierAdapters {
  abstract get(adapter: string): CourierPort | null;
}
