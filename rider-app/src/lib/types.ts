/**
 * Contrato con la API (/v1/rider/...). Los montos llegan como string con 2 decimales ("12.50"),
 * igual que en el resto del backend (numeric(12,2) en USD); las fechas, en ISO 8601 UTC.
 */
export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Shift {
  id: string;
  status: 'active' | 'completed';
  startedAt: string;
  plannedEndAt: string;
  endedAt: string | null;
}

export type Presence = 'offline' | 'available' | 'busy' | 'break';

export interface RiderProfile {
  riderId: string;
  userId: string;
  name: string | null;
  email: string;
  vehicleType: string;
  plate: string | null;
  status: string;
  presence: Presence;
  ratingAvg: string;
  ratingCount: number;
  codBalance: string;
  codLimit: string;
  codAvailable: string;
  maxConcurrent: number;
  ntfy: { url: string; topic: string };
  shift: Shift | null;
}

export interface ShiftEndResult {
  shift: Shift;
  summary: { deliveries: number; fees: string; codCollected: string };
}

export interface Slot {
  startsAt: string;
  endsAt: string;
}

export interface Offer {
  id: string;
  shipmentId: string;
  offeredAt: string;
  expiresAt: string;
  pickup: { name: string; location: GeoPoint | null };
  dropoff: { label: string; location: GeoPoint | null };
  distanceM: number | null;
  estimatedFee: string;
  codAmount: string;
  slot: Slot | null;
}

export type ShipmentStatus =
  | 'pending'
  | 'ready_for_pickup'
  | 'assigned'
  | 'accepted'
  | 'picked_up'
  | 'in_transit'
  | 'arriving'
  | 'delivered'
  | 'failed_attempt'
  | 'returned_to_origin'
  | 'cancelled';

/** Estados que el motorizado fija con POST /rider/shipments/:id/status. */
export type RiderSettableStatus = 'picked_up' | 'in_transit' | 'arriving' | 'failed_attempt';

export interface RiderShipment {
  id: string;
  orderId: string;
  orderNumber: string | null;
  status: ShipmentStatus;
  pickup: { name: string; location: GeoPoint | null } | null;
  destination: {
    label: string;
    location: GeoPoint | null;
    recipientName?: string | null;
    phone?: string | null;
    reference?: string | null;
    [key: string]: unknown;
  };
  slot: Slot | null;
  codAmount: string;
  distanceM: number | null;
  estimatedFee: string;
  requiresOtp: boolean;
  attempts: number;
  deliveredAt: string | null;
}

export type CodMethod = 'cash' | 'card_pos' | 'deuna_qr';

export interface Earnings {
  period: { from: string; to: string };
  deliveries: number;
  fees: string;
  bonusEstimate: string;
  codCollected: { total: string; cash: string; card_pos: string; deuna_qr: string };
  codBalance: string;
  codLimit: string;
  codAvailable: string;
  today: { deliveries: number; fees: string };
  byDay: Array<{ date: string; deliveries: number; fees: string; codCollected: string }>;
  items: Array<{
    shipmentId: string;
    orderNumber: string | null;
    deliveredAt: string;
    distanceM: number | null;
    fee: string;
    codAmount: string;
    codMethod: CodMethod | null;
  }>;
}

export interface AccessToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

/** Respuesta del login cuando la cuenta tiene 2FA: falta el segundo paso. */
export interface MfaChallenge {
  mfaRequired?: boolean;
  mfaSetupRequired?: boolean;
  mfaToken: string;
}

export interface LocationAck {
  recorded: number;
  liveShipments: string[];
  openOffers: number;
}
