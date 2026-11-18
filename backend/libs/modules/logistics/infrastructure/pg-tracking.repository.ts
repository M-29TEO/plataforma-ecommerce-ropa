import { Injectable } from '@nestjs/common';
import { buildSetClause, Queryable } from '../../../shared-kernel';
import { GeoPoint } from '../domain/geo';
import {
  EventSource,
  DeliveryProofRecord,
  NewDeliveryProof,
  ProofType,
  NewRiderPosition,
  RiderPosition,
  RiderPublicInfo,
  ShipmentEventView,
  StatusPatch,
  TrackedShipment,
  TrackingRepository,
} from '../application/tracking-ports';
import { RIDER_ACTIVE_STATUSES } from '../domain/tracking';

const COLUMNS = `s.id, s.tenant_id, s.order_id, s.direction, s.carrier_type, s.status, s.rider_id, s.tracking_token,
  s.destination, ST_Y(s.destination_location::geometry) AS dest_lat, ST_X(s.destination_location::geometry) AS dest_lng,
  s.origin_warehouse_id, s.cod_amount, s.cod_collected, s.cod_method, s.distance_m, s.attempts, s.otp_hash,
  sl.starts_at AS slot_starts_at, sl.ends_at AS slot_ends_at,
  s.eta, s.assigned_at, s.picked_up_at, s.delivered_at`;
const FROM = `logistics.shipments s LEFT JOIN logistics.delivery_slots sl ON sl.id = s.delivery_slot_id`;

interface Row {
  id: string;
  tenant_id: string;
  order_id: string;
  direction: TrackedShipment['direction'];
  carrier_type: string;
  status: string;
  rider_id: string | null;
  tracking_token: string;
  destination: Record<string, unknown>;
  dest_lat: number | null;
  dest_lng: number | null;
  origin_warehouse_id: string | null;
  cod_amount: string;
  cod_collected: string | null;
  cod_method: string | null;
  distance_m: number | null;
  attempts: number;
  otp_hash: Buffer | null;
  slot_starts_at: Date | null;
  slot_ends_at: Date | null;
  eta: Date | null;
  assigned_at: Date | null;
  picked_up_at: Date | null;
  delivered_at: Date | null;
}

function toShipment(r: Row): TrackedShipment {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    orderId: r.order_id,
    direction: r.direction,
    carrierType: r.carrier_type,
    status: r.status,
    riderId: r.rider_id,
    trackingToken: r.tracking_token,
    destination: r.destination ?? {},
    destinationLocation: r.dest_lat !== null && r.dest_lng !== null ? { lat: r.dest_lat, lng: r.dest_lng } : null,
    originWarehouseId: r.origin_warehouse_id,
    codAmount: r.cod_amount,
    codCollected: r.cod_collected,
    codMethod: r.cod_method,
    distanceM: r.distance_m,
    attempts: r.attempts,
    otpHash: r.otp_hash,
    slot: r.slot_starts_at && r.slot_ends_at ? { startsAt: r.slot_starts_at.toISOString(), endsAt: r.slot_ends_at.toISOString() } : null,
    eta: r.eta,
    assignedAt: r.assigned_at,
    pickedUpAt: r.picked_up_at,
    deliveredAt: r.delivered_at,
  };
}

const PROOF_COLUMNS = `p.id, p.shipment_id, p.proof_type, p.storage_key, p.otp_verified, p.receiver_name, p.distance_to_destination_m, p.captured_at`;

interface ProofRow {
  id: string;
  shipment_id: string;
  proof_type: ProofType;
  storage_key: string | null;
  otp_verified: boolean | null;
  receiver_name: string | null;
  distance_to_destination_m: number | null;
  captured_at: Date;
}

function toProof(r: ProofRow): DeliveryProofRecord {
  return {
    id: r.id,
    shipmentId: r.shipment_id,
    proofType: r.proof_type,
    storageKey: r.storage_key,
    otpVerified: r.otp_verified,
    receiverName: r.receiver_name,
    distanceToDestinationM: r.distance_to_destination_m,
    capturedAt: r.captured_at,
  };
}

const POINT = (lngParam: string, latParam: string) => `ST_SetSRID(ST_MakePoint(${lngParam}, ${latParam}), 4326)::geography`;

@Injectable()
export class PgTrackingRepository extends TrackingRepository {
  async findByToken(q: Queryable, token: string, tenantId?: string): Promise<TrackedShipment | null> {
    const { rows } = await q.query<Row>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE s.tracking_token = $1 AND ($2::uuid IS NULL OR s.tenant_id = $2)`,
      [token, tenantId ?? null],
    );
    return rows[0] ? toShipment(rows[0]) : null;
  }

  async findById(q: Queryable, tenantId: string, id: string, opts: { lock?: boolean } = {}): Promise<TrackedShipment | null> {
    const { rows } = await q.query<Row>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE s.tenant_id = $1 AND s.id = $2 ${opts.lock ? 'FOR UPDATE OF s' : ''}`,
      [tenantId, id],
    );
    return rows[0] ? toShipment(rows[0]) : null;
  }

  async listActiveForRider(q: Queryable, riderId: string): Promise<TrackedShipment[]> {
    const { rows } = await q.query<Row>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE s.rider_id = $1 AND s.status = ANY($2::text[]) ORDER BY s.assigned_at, s.created_at`,
      [riderId, RIDER_ACTIVE_STATUSES],
    );
    return rows.map(toShipment);
  }

  async updateStatus(q: Queryable, id: string, patch: StatusPatch): Promise<void> {
    // buildSetClause serializa los objetos como JSON: las fechas van como texto ISO.
    const values = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
    const set = buildSetClause(
      values,
      {
        status: 'status',
        riderId: 'rider_id',
        assignedAt: 'assigned_at',
        pickedUpAt: 'picked_up_at',
        deliveredAt: 'delivered_at',
        eta: 'eta',
        codCollected: 'cod_collected',
        codMethod: 'cod_method',
      },
      2,
    );
    await q.query(`UPDATE logistics.shipments SET ${set.sql}, updated_at = now(), version = version + 1 WHERE id = $1`, [id, ...set.values]);
  }

  async insertEvent(
    q: Queryable,
    shipmentId: string,
    status: string,
    description: string,
    source: EventSource,
    at: Date,
    location?: GeoPoint | null,
  ): Promise<void> {
    await q.query(
      `INSERT INTO logistics.shipment_events (shipment_id, status, description, source, occurred_at, location)
       VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $6::float8 IS NULL THEN NULL ELSE ${POINT('$7::float8', '$6::float8')} END)
       ON CONFLICT (shipment_id, status, occurred_at) DO NOTHING`,
      [shipmentId, status, description, source, at, location?.lat ?? null, location?.lng ?? null],
    );
  }

  async listEvents(q: Queryable, shipmentId: string): Promise<ShipmentEventView[]> {
    const { rows } = await q.query<{ status: string; description: string | null; occurred_at: Date }>(
      `SELECT status, description, occurred_at FROM logistics.shipment_events WHERE shipment_id = $1 ORDER BY occurred_at, id`,
      [shipmentId],
    );
    return rows.map((r) => ({ status: r.status, description: r.description, occurredAt: r.occurred_at.toISOString() }));
  }

  async insertPosition(q: Queryable, p: NewRiderPosition): Promise<void> {
    await q.query(
      `INSERT INTO logistics.rider_location_history (rider_id, recorded_at, location, speed_kmh, heading, accuracy_m, shipment_id)
       VALUES ($1, $2, ${POINT('$4', '$3')}, $5, $6, $7, $8)`,
      [p.riderId, p.recordedAt, p.lat, p.lng, p.speedKmh, p.heading, p.accuracyM, p.shipmentId],
    );
  }

  async lastPosition(q: Queryable, riderId: string, shipmentId: string, since: Date): Promise<RiderPosition | null> {
    const { rows } = await q.query<{ lat: number; lng: number; heading: number | null; speed_kmh: number | null; recorded_at: Date }>(
      `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, heading, speed_kmh, recorded_at
         FROM logistics.rider_location_history
        WHERE rider_id = $1 AND shipment_id = $2 AND recorded_at >= $3
        ORDER BY recorded_at DESC LIMIT 1`,
      [riderId, shipmentId, since],
    );
    const r = rows[0];
    return r ? { lat: r.lat, lng: r.lng, heading: r.heading, speedKmh: r.speed_kmh, recordedAt: r.recorded_at.toISOString() } : null;
  }

  async riderInfo(q: Queryable, riderId: string): Promise<RiderPublicInfo | null> {
    const { rows } = await q.query<{ vehicle_type: string; plate: string | null; rating_avg: string; rating_count: number }>(
      `SELECT vehicle_type, plate, to_char(rating_avg, 'FM0.00') AS rating_avg, rating_count FROM logistics.riders WHERE id = $1`,
      [riderId],
    );
    const r = rows[0];
    return r ? { vehicleType: r.vehicle_type, plate: r.plate, ratingAvg: r.rating_avg, ratingCount: r.rating_count } : null;
  }

  async insertProof(q: Queryable, p: NewDeliveryProof): Promise<void> {
    await q.query(
      `INSERT INTO logistics.delivery_proofs (shipment_id, proof_type, storage_key, otp_verified, receiver_name, location, distance_to_destination_m, captured_at)
       VALUES ($1, $2, $3, $4, $5, ${POINT('$7', '$6')}, $8, $9)`,
      [p.shipmentId, p.proofType, p.storageKey ?? null, p.otpVerified ?? null, p.receiverName ?? null, p.location.lat, p.location.lng, p.distanceToDestinationM, p.capturedAt],
    );
  }

  async listProofs(q: Queryable, tenantId: string, shipmentId: string): Promise<DeliveryProofRecord[]> {
    const { rows } = await q.query<ProofRow>(
      `SELECT ${PROOF_COLUMNS} FROM logistics.delivery_proofs p JOIN logistics.shipments s ON s.id = p.shipment_id
        WHERE s.tenant_id = $1 AND p.shipment_id = $2 ORDER BY p.captured_at, p.proof_type, p.id`,
      [tenantId, shipmentId],
    );
    return rows.map(toProof);
  }

  async findProof(q: Queryable, tenantId: string, proofId: string): Promise<DeliveryProofRecord | null> {
    const { rows } = await q.query<ProofRow>(
      `SELECT ${PROOF_COLUMNS} FROM logistics.delivery_proofs p JOIN logistics.shipments s ON s.id = p.shipment_id
        WHERE s.tenant_id = $1 AND p.id = $2`,
      [tenantId, proofId],
    );
    return rows[0] ? toProof(rows[0]) : null;
  }

  async countOtpFailures(q: Queryable, shipmentId: string, since: Date): Promise<number> {
    const { rows } = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM logistics.delivery_proofs
        WHERE shipment_id = $1 AND proof_type = 'otp' AND otp_verified = false AND captured_at >= $2`,
      [shipmentId, since],
    );
    return rows[0].n;
  }

  async setOtpHash(q: Queryable, shipmentId: string, hash: Buffer): Promise<void> {
    await q.query(`UPDATE logistics.shipments SET otp_hash = $2 WHERE id = $1`, [shipmentId, hash]);
  }

  async incrementAttempts(q: Queryable, shipmentId: string): Promise<void> {
    await q.query(`UPDATE logistics.shipments SET attempts = attempts + 1 WHERE id = $1`, [shipmentId]);
  }
}
