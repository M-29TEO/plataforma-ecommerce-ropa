import { Queryable } from '../../../shared-kernel';
import { GeoPoint } from '../domain/geo';
import { RiderPresence } from '../domain/tracking';

/** Motorizado con su última posición (lectura del mapa en vivo; sin datos de IAM). */
export interface LiveRiderRow {
  riderId: string;
  userId: string;
  vehicleType: string;
  plate: string | null;
  status: string;
  presence: string;
  codBalance: string;
  codLimit: string;
  ratingAvg: string;
  lastLocation: { lat: number; lng: number; heading: number | null; speedKmh: number | null; recordedAt: string } | null;
}

export interface ActiveShipmentRow {
  shipmentId: string;
  orderId: string;
  riderId: string;
  status: string;
  dropoff: GeoPoint | null;
}

export interface ShipmentListFilter {
  statuses?: string[];
  carrierType?: string;
  zoneId?: string;
  riderId?: string;
  limit: number;
  offset: number;
}

export interface ShipmentListRow {
  id: string;
  orderId: string;
  direction: string;
  carrierType: string;
  status: string;
  zoneId: string | null;
  riderId: string | null;
  codAmount: string;
  slot: { startsAt: string; endsAt: string } | null;
  createdAt: string;
  destination: Record<string, unknown>;
  dropoff: GeoPoint | null;
}

/** Lecturas del backoffice de logística (mapa en vivo y cola de despacho), schema logistics. */
export abstract class LiveOpsRepository {
  /** Motorizados no inactivos del tenant con su última posición desde `since` (LATERAL sobre ix_rlh). */
  abstract listRiders(q: Queryable, tenantId: string, since: Date): Promise<LiveRiderRow[]>;
  /** Envíos activos (asignado → llegando) de esos motorizados (ix_ship_rider_active). */
  abstract listActiveShipments(q: Queryable, tenantId: string, riderIds: string[]): Promise<ActiveShipmentRow[]>;
  abstract listShipments(q: Queryable, tenantId: string, filter: ShipmentListFilter): Promise<{ rows: ShipmentListRow[]; total: number }>;
  /** null si el motorizado no existe en el tenant. */
  abstract setPresence(q: Queryable, tenantId: string, userId: string, presence: RiderPresence): Promise<{ riderId: string } | null>;
}
