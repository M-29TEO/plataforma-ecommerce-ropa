import { Queryable } from '../../../shared-kernel';
import { GeoPoint } from '../domain/geo';

export type EventSource = 'rider_app' | 'system' | 'staff';

export interface TrackedShipment {
  id: string;
  tenantId: string;
  orderId: string;
  direction: 'outbound' | 'return' | 'exchange';
  carrierType: string;
  status: string;
  riderId: string | null;
  trackingToken: string;
  destination: Record<string, unknown>;
  destinationLocation: GeoPoint | null;
  originWarehouseId: string | null;
  codAmount: string;
  codCollected: string | null;
  codMethod: string | null;
  /** Ruta bodega → destino (la que se cobra y se paga al motorizado). */
  distanceM: number | null;
  attempts: number;
  /** SHA-256 del código de entrega (se fija al retirar); null antes. */
  otpHash: Buffer | null;
  slot: { startsAt: string; endsAt: string } | null;
  eta: Date | null;
  assignedAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
}

export interface ShipmentEventView {
  status: string;
  description: string | null;
  occurredAt: string;
}

export interface RiderPosition extends GeoPoint {
  heading: number | null;
  speedKmh: number | null;
  recordedAt: string;
}

export interface NewRiderPosition extends GeoPoint {
  riderId: string;
  shipmentId: string | null;
  heading: number | null;
  speedKmh: number | null;
  accuracyM: number | null;
  recordedAt: Date;
}

export interface RiderPublicInfo {
  vehicleType: string;
  plate: string | null;
  ratingAvg: string;
  ratingCount: number;
}

export interface StatusPatch {
  status: string;
  riderId?: string;
  assignedAt?: Date;
  pickedUpAt?: Date;
  deliveredAt?: Date;
  eta?: Date | null;
  codCollected?: string;
  codMethod?: 'cash' | 'card_pos' | 'deuna_qr';
}

export type ProofType = 'photo' | 'signature' | 'otp' | 'id_check';

export interface NewDeliveryProof {
  shipmentId: string;
  proofType: ProofType;
  storageKey?: string | null;
  otpVerified?: boolean | null;
  receiverName?: string | null;
  location: GeoPoint;
  distanceToDestinationM: number | null;
  capturedAt: Date;
}

export interface DeliveryProofRecord {
  id: string;
  shipmentId: string;
  proofType: ProofType;
  storageKey: string | null;
  otpVerified: boolean | null;
  receiverName: string | null;
  distanceToDestinationM: number | null;
  capturedAt: Date;
}

/** Envíos con motorizado: estado, eventos, posiciones y prueba de entrega (schema logistics). */
export abstract class TrackingRepository {
  /** Por token público (único en toda la base). Con tenantId, además debe ser de ese tenant. */
  abstract findByToken(q: Queryable, token: string, tenantId?: string): Promise<TrackedShipment | null>;
  abstract findById(q: Queryable, tenantId: string, id: string, opts?: { lock?: boolean }): Promise<TrackedShipment | null>;
  abstract listActiveForRider(q: Queryable, riderId: string): Promise<TrackedShipment[]>;
  abstract updateStatus(q: Queryable, id: string, patch: StatusPatch): Promise<void>;
  abstract insertEvent(q: Queryable, shipmentId: string, status: string, description: string, source: EventSource, at: Date, location?: GeoPoint | null): Promise<void>;
  abstract listEvents(q: Queryable, shipmentId: string): Promise<ShipmentEventView[]>;
  abstract insertPosition(q: Queryable, p: NewRiderPosition): Promise<void>;
  /** Última posición del motorizado en ese envío desde `since`. */
  abstract lastPosition(q: Queryable, riderId: string, shipmentId: string, since: Date): Promise<RiderPosition | null>;
  abstract riderInfo(q: Queryable, riderId: string): Promise<RiderPublicInfo | null>;
  abstract insertProof(q: Queryable, p: NewDeliveryProof): Promise<void>;
  /** Pruebas de un envío del tenant (orden de captura). */
  abstract listProofs(q: Queryable, tenantId: string, shipmentId: string): Promise<DeliveryProofRecord[]>;
  abstract findProof(q: Queryable, tenantId: string, proofId: string): Promise<DeliveryProofRecord | null>;
  /** Códigos de entrega incorrectos del envío desde `since` (filas 'otp' con otp_verified = false). */
  abstract countOtpFailures(q: Queryable, shipmentId: string, since: Date): Promise<number>;
  abstract setOtpHash(q: Queryable, shipmentId: string, hash: Buffer): Promise<void>;
  abstract incrementAttempts(q: Queryable, shipmentId: string): Promise<void>;
}
