import { ConflictError, NotFoundError, toCents } from '../../../shared-kernel';
import { GeoPoint, haversineMeters } from './geo';

/**
 * Despacho automático (logistics.dispatch_offers): cuando un envío con motorizado queda listo para
 * retirar, se ofrece al MEJOR motorizado disponible; tiene DISPATCH_OFFER_TTL_SECONDS para aceptar.
 * Si rechaza o deja vencer la oferta, se ofrece al siguiente. A un mismo motorizado no se le ofrece
 * dos veces el mismo envío; si no queda nadie, el envío espera la asignación manual del backoffice.
 *
 * Una sola oferta abierta por envío (índice único parcial ux_offers_shipment_open, migración 0018).
 */

/** Una posición más vieja que esto no sirve para elegir motorizado (no se sabe dónde está). */
export const DISPATCH_POSITION_MAX_AGE_MS = 15 * 60 * 1000;
/** Más allá de esta distancia a la bodega, el componente de distancia del puntaje es 0. */
export const DISPATCH_MAX_USEFUL_DISTANCE_M = 10_000;
/** Pesos del puntaje (suman 100): la cercanía a la bodega manda; calificación y carga desempatan. */
export const SCORE_WEIGHTS = { distance: 70, rating: 20, load: 10 } as const;

export interface DispatchCandidate {
  riderId: string;
  presence: string;
  maxConcurrent: number;
  /** Envíos que lleva ahora (asignado → intento fallido). */
  activeShipments: number;
  ratingAvg: string;
  codLimit: string;
  codBalance: string;
  /** Última posición conocida (ya filtrada a los últimos 15 min por la consulta, se vuelve a verificar). */
  position: (GeoPoint & { recordedAt: Date }) | null;
}

export interface DispatchTarget {
  /** Bodega de origen (donde retira); si falta, el destino. */
  pickup: GeoPoint | null;
  codAmount: string;
}

export interface ScoreBreakdown {
  distanceM: number | null;
  distancePts: number;
  rating: number;
  ratingPts: number;
  activeShipments: number;
  maxConcurrent: number;
  loadPts: number;
}

export interface ScoredCandidate {
  riderId: string;
  score: number;
  breakdown: ScoreBreakdown;
}

export type IneligibleReason = 'presence' | 'capacity' | 'cod' | 'stale_position';

/** Por qué un motorizado no puede recibir la oferta (null = puede). */
export function ineligibility(c: DispatchCandidate, target: DispatchTarget, now: Date): IneligibleReason | null {
  if (c.presence !== 'available' && c.presence !== 'busy') return 'presence';
  if (c.activeShipments >= c.maxConcurrent) return 'capacity';
  if (!c.position || now.getTime() - c.position.recordedAt.getTime() > DISPATCH_POSITION_MAX_AGE_MS) return 'stale_position';
  const codAmount = toCents(target.codAmount);
  if (codAmount > 0) {
    const available = toCents(c.codLimit) - toCents(c.codBalance);
    if (available < codAmount) return 'cod';
  }
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Puntaje de 0 a 100:
 *  - distancia en línea recta de su última posición a la bodega: 70 a 0 m, 0 desde 10 km (lineal);
 *  - calificación promedio (1 a 5): 0 a 20;
 *  - carga actual: 10 sin envíos, 0 con el tope lleno.
 */
export function scoreCandidate(c: DispatchCandidate, target: DispatchTarget): ScoredCandidate {
  const distanceM = c.position && target.pickup ? Math.round(haversineMeters(c.position, target.pickup)) : null;
  const distancePts = distanceM === null ? 0 : SCORE_WEIGHTS.distance * Math.max(0, 1 - distanceM / DISPATCH_MAX_USEFUL_DISTANCE_M);
  const rating = Math.min(5, Math.max(1, Number(c.ratingAvg) || 5));
  const ratingPts = (SCORE_WEIGHTS.rating * (rating - 1)) / 4;
  const loadPts = c.maxConcurrent > 0 ? SCORE_WEIGHTS.load * Math.max(0, 1 - c.activeShipments / c.maxConcurrent) : 0;
  const score = Math.round((distancePts + ratingPts + loadPts) * 10_000) / 10_000;
  return {
    riderId: c.riderId,
    score,
    breakdown: {
      distanceM,
      distancePts: round2(distancePts),
      rating,
      ratingPts: round2(ratingPts),
      activeShipments: c.activeShipments,
      maxConcurrent: c.maxConcurrent,
      loadPts: round2(loadPts),
    },
  };
}

/**
 * Motorizados elegibles ordenados del mejor al peor. Empate: el más cercano y luego el id (orden
 * estable, así dos réplicas eligen igual).
 */
export function rankCandidates(candidates: DispatchCandidate[], target: DispatchTarget, now: Date): ScoredCandidate[] {
  return candidates
    .filter((c) => ineligibility(c, target, now) === null)
    .map((c) => scoreCandidate(c, target))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.breakdown.distanceM ?? Infinity) - (b.breakdown.distanceM ?? Infinity) ||
        a.riderId.localeCompare(b.riderId),
    );
}

/** Estados desde los que un envío se puede ofrecer (sin motorizado todavía). */
export const DISPATCHABLE_STATUSES = ['pending', 'ready_for_pickup'] as const;

export function isDispatchable(s: { status: string; riderId: string | null; carrierType: string; direction: string }): boolean {
  return (DISPATCHABLE_STATUSES as readonly string[]).includes(s.status) && s.riderId === null && s.carrierType === 'rider' && s.direction === 'outbound';
}

/** Respuesta de una oferta (dispatch_offers.response); null = abierta. */
export type OfferResponse = 'accepted' | 'rejected' | 'expired' | 'cancelled';

export interface OfferState {
  response: OfferResponse | null;
  expiresAt: Date;
}

/** La oferta se puede aceptar o rechazar: abierta y sin vencer. Si no, el error que corresponde. */
export function assertOfferOpen(o: OfferState, now: Date): void {
  if (o.response === 'expired' || (o.response === null && o.expiresAt.getTime() <= now.getTime())) throw new OfferExpiredError();
  if (o.response !== null) throw new OfferClosedError(o.response);
}

export class NoRiderAvailableError extends ConflictError {
  constructor(shipmentId: string) {
    super('NO_RIDER_AVAILABLE', 'No hay motorizados disponibles para este envío: asígnalo a mano', { shipmentId });
  }
}

export class ShipmentNotDispatchableError extends ConflictError {
  constructor(shipmentId: string, status: string) {
    super('SHIPMENT_NOT_DISPATCHABLE', 'El envío ya tiene motorizado o no está pendiente de despacho', { shipmentId, status });
  }
}

export class OfferNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('OFFER_NOT_FOUND', 'La oferta no existe', { id });
  }
}

export class OfferExpiredError extends ConflictError {
  constructor() {
    super('OFFER_EXPIRED', 'La oferta venció: se ofreció a otro motorizado');
  }
}

export class OfferClosedError extends ConflictError {
  constructor(response: string) {
    super('OFFER_CLOSED', 'La oferta ya no está disponible', { response });
  }
}
