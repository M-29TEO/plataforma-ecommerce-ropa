/**
 * Puertos de la app del motorizado: despacho automático (dispatch_offers), turnos (rider_shifts),
 * perfil y ganancias, avisos de ofertas (ntfy) y almacenamiento de las pruebas de entrega.
 */
import { ObjectStorage, Queryable } from '../../../shared-kernel';
import { DispatchCandidate, OfferResponse, ScoreBreakdown } from '../domain/dispatch';
import { EarningsDelivery } from '../domain/earnings';
import { ShiftRecord } from '../domain/shift';

// ---------------------------------------------------------------- Ofertas
export interface OfferRecord {
  id: string;
  shipmentId: string;
  riderId: string;
  score: string;
  offeredAt: Date;
  expiresAt: Date;
  response: OfferResponse | null;
  respondedAt: Date | null;
}

export interface NewOffer {
  shipmentId: string;
  riderId: string;
  score: number;
  breakdown: ScoreBreakdown;
  offeredAt: Date;
  expiresAt: Date;
}

export interface ClosedOffer {
  offerId: string;
  shipmentId: string;
  riderId: string;
  tenantId: string;
}

export abstract class DispatchRepository {
  /**
   * Motorizados del tenant que podrían recibir la oferta: activos, con turno activo, presencia
   * available/busy, posición desde `since`, sin otra oferta abierta y a los que nunca se les
   * ofreció este envío. La elegibilidad fina (tope, efectivo) la decide domain/dispatch.
   */
  abstract listCandidates(q: Queryable, tenantId: string, shipmentId: string, since: Date, now: Date): Promise<DispatchCandidate[]>;
  abstract insertOffer(q: Queryable, o: NewOffer): Promise<OfferRecord>;
  abstract findOffer(q: Queryable, id: string, opts?: { lock?: boolean }): Promise<OfferRecord | null>;
  /** Oferta sin respuesta del envío (vencida o no). */
  abstract findOpenForShipment(q: Queryable, shipmentId: string): Promise<OfferRecord | null>;
  abstract respond(q: Queryable, id: string, response: OfferResponse, at: Date, rejectReason?: string | null): Promise<void>;
  /** Abiertas y sin vencer del motorizado, de la más vieja a la más nueva. */
  abstract listOpenForRider(q: Queryable, riderId: string, now: Date): Promise<OfferRecord[]>;
  abstract countOpenForRider(q: Queryable, riderId: string, now: Date): Promise<number>;
  /** Abiertas con expires_at <= now (de todos los tenants, o de uno). */
  abstract listDue(q: Queryable, now: Date, limit: number, tenantId?: string): Promise<ClosedOffer[]>;
  /** Envíos con motorizado listos para retirar, sin motorizado ni oferta abierta (los más nuevos primero). */
  abstract listUndispatched(q: Queryable, limit: number, tenantId?: string): Promise<{ tenantId: string; shipmentId: string }[]>;
  /** Marca 'cancelled' las ofertas abiertas del motorizado (fin de turno). */
  abstract cancelOpenForRider(q: Queryable, riderId: string, at: Date): Promise<ClosedOffer[]>;
  /** Marca 'cancelled' las ofertas abiertas del envío (asignación manual). */
  abstract cancelOpenForShipment(q: Queryable, shipmentId: string, at: Date): Promise<ClosedOffer[]>;
}

/** Aviso al teléfono del motorizado. Sin datos del cliente: los tópicos de ntfy son públicos. */
export interface OfferNotification {
  topic: string;
  ttlSeconds: number;
}

export abstract class RiderOfferNotifier {
  abstract notifyOffer(n: OfferNotification): Promise<void>;
}

/** Token de inyección del ObjectStorage de las pruebas (claves logistics/proofs/...). */
export abstract class DeliveryProofStorage extends ObjectStorage {}

// ---------------------------------------------------------------- Perfil, turnos y ganancias
export interface RiderProfile {
  riderId: string;
  userId: string;
  tenantId: string;
  vehicleType: string;
  plate: string | null;
  status: string;
  presence: string;
  ratingAvg: string;
  ratingCount: number;
  codBalance: string;
  codLimit: string;
  maxConcurrent: number;
  homeZoneId: string | null;
  ntfyTopic: string | null;
  commissionScheme: unknown;
}

export abstract class RiderAppRepository {
  abstract findProfile(q: Queryable, tenantId: string, userId: string): Promise<RiderProfile | null>;
  /** Fija el tópico solo si no tenía (carrera: gana el primero) y devuelve el vigente. */
  abstract ensureNtfyTopic(q: Queryable, riderId: string, candidate: string): Promise<string>;
  abstract lockRider(q: Queryable, riderId: string): Promise<void>;
  abstract findActiveShift(q: Queryable, riderId: string): Promise<ShiftRecord | null>;
  abstract listScheduledCovering(q: Queryable, riderId: string, now: Date): Promise<ShiftRecord[]>;
  abstract activateShift(q: Queryable, id: string, now: Date): Promise<ShiftRecord>;
  abstract insertActiveShift(q: Queryable, s: { riderId: string; zoneId: string | null; startsAt: Date; endsAt: Date; checkedInAt: Date }): Promise<ShiftRecord>;
  abstract completeShift(q: Queryable, id: string, now: Date): Promise<ShiftRecord>;
  abstract setPresence(q: Queryable, riderId: string, presence: string): Promise<void>;
  /** Entregas del motorizado con delivered_at en [from, to). */
  abstract listDelivered(q: Queryable, riderId: string, from: Date, to: Date): Promise<EarningsDelivery[]>;
}
