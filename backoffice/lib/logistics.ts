import type { Tone } from '@/components/ui/Badge';
import { formatDate, formatTime, toNumber } from './format';

/**
 * Logística en el backoffice: tipos de las respuestas del API (/v1/logistics/*), el reducer que
 * aplica los eventos del socket del staff sobre los motorizados en vivo y los cálculos puros del
 * despacho (distancia en línea recta) y de las liquidaciones semanales.
 */

// ---------------------------------------------------------------- Motorizados en vivo
export type RiderPresence = 'offline' | 'available' | 'busy' | 'break';
export const PRESENCES: readonly RiderPresence[] = ['available', 'busy', 'break', 'offline'];

export const PRESENCE_LABEL: Record<RiderPresence, [string, Tone]> = {
  available: ['Disponible', 'ok'],
  busy: ['Ocupado', 'accent'],
  break: ['En pausa', 'warn'],
  offline: ['Desconectado', 'neutral'],
};

/** Color del marcador en el mapa (los mismos tonos de la interfaz). */
export const PRESENCE_COLOR: Record<RiderPresence, string> = {
  available: '#2f6b3a',
  busy: '#b4532a',
  break: '#a8640f',
  offline: '#8a8178',
};

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RiderLocation extends LatLng {
  heading: number | null;
  speedKmh: number | null;
  recordedAt: string;
}

export interface ActiveShipment {
  shipmentId: string;
  orderId: string;
  status: string;
  dropoff: LatLng | null;
}

/** GET /v1/logistics/riders/live */
export interface LiveRider {
  riderId: string;
  userId: string;
  name: string | null;
  phone: string | null;
  vehicleType: string | null;
  plate: string | null;
  status: string;
  presence: RiderPresence;
  codBalance: string;
  codLimit: string;
  ratingAvg: string | null;
  lastLocation: RiderLocation | null;
  activeShipments: ActiveShipment[];
  /** Solo en el cliente: hora del último cambio de presencia recibido por el socket. */
  presenceChangedAt?: string;
}

/** Envíos que el motorizado lleva (tracking.ts RIDER_ACTIVE_STATUSES). */
export const RIDER_ACTIVE_STATUSES = ['assigned', 'accepted', 'picked_up', 'in_transit', 'arriving'] as const;

export function isActiveShipmentStatus(status: string): boolean {
  return (RIDER_ACTIVE_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------- Eventos del socket /staff
export interface RiderLocationEvent extends LatLng {
  riderId: string;
  heading: number | null;
  speedKmh: number | null;
  recordedAt: string;
  shipmentId: string | null;
}

export interface ShipmentStatusEvent {
  shipmentId: string;
  orderId: string;
  riderId: string | null;
  status: string;
}

export interface RiderPresenceEvent {
  riderId: string;
  presence: RiderPresence;
  changedAt: string;
}

export type StaffEvent =
  | { type: 'location'; data: RiderLocationEvent }
  | { type: 'status'; data: ShipmentStatusEvent }
  | { type: 'presence'; data: RiderPresenceEvent };

function time(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * Aplica un evento del socket a la lista de motorizados. Puro: devuelve la MISMA lista si el
 * evento no cambia nada (motorizado desconocido, posición o presencia más vieja que la que ya se
 * tiene), así React no vuelve a pintar.
 */
export function reduceRiders(riders: LiveRider[], event: StaffEvent): LiveRider[] {
  switch (event.type) {
    case 'location': {
      const e = event.data;
      const i = riders.findIndex((r) => r.riderId === e.riderId);
      if (i < 0) return riders;
      const current = riders[i].lastLocation;
      if (current && time(current.recordedAt) >= time(e.recordedAt)) return riders;
      const next = riders.slice();
      next[i] = { ...riders[i], lastLocation: { lat: e.lat, lng: e.lng, heading: e.heading, speedKmh: e.speedKmh, recordedAt: e.recordedAt } };
      return next;
    }
    case 'presence': {
      const e = event.data;
      const i = riders.findIndex((r) => r.riderId === e.riderId);
      if (i < 0) return riders;
      const r = riders[i];
      if (r.presenceChangedAt && time(r.presenceChangedAt) > time(e.changedAt)) return riders;
      if (r.presence === e.presence && r.presenceChangedAt === e.changedAt) return riders;
      const next = riders.slice();
      next[i] = { ...r, presence: e.presence, presenceChangedAt: e.changedAt };
      return next;
    }
    case 'status': {
      const e = event.data;
      const keep = isActiveShipmentStatus(e.status) && e.riderId !== null;
      let previous: ActiveShipment | undefined;
      let changed = false;
      const next = riders.map((r) => {
        const idx = r.activeShipments.findIndex((s) => s.shipmentId === e.shipmentId);
        if (idx < 0) return r;
        previous = r.activeShipments[idx];
        if (keep && r.riderId === e.riderId) {
          if (previous.status === e.status) return r;
          changed = true;
          const list = r.activeShipments.slice();
          list[idx] = { ...previous, status: e.status };
          return { ...r, activeShipments: list };
        }
        changed = true;
        return { ...r, activeShipments: r.activeShipments.filter((s) => s.shipmentId !== e.shipmentId) };
      });
      if (keep) {
        const i = next.findIndex((r) => r.riderId === e.riderId);
        if (i >= 0 && !next[i].activeShipments.some((s) => s.shipmentId === e.shipmentId)) {
          changed = true;
          next[i] = {
            ...next[i],
            activeShipments: [...next[i].activeShipments, { shipmentId: e.shipmentId, orderId: e.orderId, status: e.status, dropoff: previous?.dropoff ?? null }],
          };
        }
      }
      return changed ? next : riders;
    }
  }
}

/**
 * ¿Hace falta volver a pedir riders/live? Los eventos no traen todo: un motorizado nuevo o un
 * envío recién asignado (sin destino conocido) solo se completan por HTTP.
 */
export function needsRefetch(riders: LiveRider[], event: StaffEvent): boolean {
  const rider = riders.find((r) => r.riderId === event.data.riderId);
  if (event.type !== 'status') return !rider;
  const e = event.data;
  if (!isActiveShipmentStatus(e.status) || !e.riderId) return false;
  if (!rider) return true;
  const known = riders.some((r) => r.activeShipments.some((s) => s.shipmentId === e.shipmentId && s.dropoff));
  return !known;
}

/** Más de 5 minutos sin reportar posición: el marcador se atenúa. */
export const STALE_POSITION_MS = 5 * 60 * 1000;

export function isStale(location: RiderLocation | null, now: number = Date.now()): boolean {
  if (!location) return true;
  return now - time(location.recordedAt) > STALE_POSITION_MS;
}

export function isOverCodLimit(r: Pick<LiveRider, 'codBalance' | 'codLimit'>): boolean {
  const balance = toNumber(r.codBalance) ?? 0;
  const limit = toNumber(r.codLimit);
  return limit !== null && balance > limit;
}

/** Proporción del límite de efectivo usada (0..∞), para la barra del saldo. */
export function codUsage(r: Pick<LiveRider, 'codBalance' | 'codLimit'>): number {
  const balance = toNumber(r.codBalance) ?? 0;
  const limit = toNumber(r.codLimit) ?? 0;
  if (limit <= 0) return balance > 0 ? Infinity : 0;
  return balance / limit;
}

export function countByPresence(riders: LiveRider[]): Record<RiderPresence, number> {
  const out: Record<RiderPresence, number> = { available: 0, busy: 0, break: 0, offline: 0 };
  for (const r of riders) out[r.presence] = (out[r.presence] ?? 0) + 1;
  return out;
}

export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Búsqueda por nombre, teléfono o placa, y filtro por presencia ('' = todas). */
export function filterRiders(riders: LiveRider[], search: string, presence: RiderPresence | ''): LiveRider[] {
  const q = normalizeSearch(search);
  return riders.filter((r) => {
    if (presence && r.presence !== presence) return false;
    if (!q) return true;
    return [r.name, r.phone, r.plate].some((v) => v && normalizeSearch(v).includes(q));
  });
}

// ---------------------------------------------------------------- Distancia
const EARTH_RADIUS_M = 6_371_000;

/** Distancia en línea recta (gran círculo) en metros. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(meters: number | null): string {
  if (meters === null || !Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toLocaleString('es-EC', { maximumFractionDigits: 1 })} km`;
}

const PRESENCE_ORDER: Record<RiderPresence, number> = { available: 0, busy: 1, break: 2, offline: 3 };

export interface RankedRider {
  rider: LiveRider;
  /** Metros en línea recta de su última posición al destino; null sin posición o sin destino. */
  distanceM: number | null;
}

/** Candidatos para un envío: primero por disponibilidad y luego por cercanía al destino. */
export function rankRiders(riders: LiveRider[], dropoff: LatLng | null): RankedRider[] {
  return riders
    .map((rider) => ({ rider, distanceM: dropoff && rider.lastLocation ? haversineMeters(rider.lastLocation, dropoff) : null }))
    .sort((a, b) => {
      const p = PRESENCE_ORDER[a.rider.presence] - PRESENCE_ORDER[b.rider.presence];
      if (p !== 0) return p;
      if (a.distanceM === null && b.distanceM === null) return (a.rider.name ?? '').localeCompare(b.rider.name ?? '');
      if (a.distanceM === null) return 1;
      if (b.distanceM === null) return -1;
      return a.distanceM - b.distanceM;
    });
}

// ---------------------------------------------------------------- Envíos (despacho)
export const SHIPMENT_STATUS: Record<string, [string, Tone]> = {
  pending: ['Pendiente', 'warn'],
  ready_for_pickup: ['Listo para retirar', 'info'],
  assigned: ['Asignado', 'accent'],
  accepted: ['Aceptado', 'accent'],
  picked_up: ['Retirado', 'accent'],
  in_transit: ['En camino', 'accent'],
  arriving: ['Llegando', 'accent'],
  delivered: ['Entregado', 'ok'],
  failed_attempt: ['Intento fallido', 'danger'],
  returned_to_origin: ['Devuelto', 'danger'],
  cancelled: ['Cancelado', 'neutral'],
};

export interface Slot {
  startsAt: string;
  endsAt: string;
}

/** Ítem de GET /v1/logistics/shipments (del más antiguo al más nuevo). */
export interface ShipmentListItem {
  id: string;
  orderId: string;
  direction: string;
  carrierType: 'rider' | 'courier' | 'pickup';
  status: string;
  zoneId: string | null;
  riderId: string | null;
  codAmount: string | null;
  slot: Slot | null;
  createdAt: string;
  destinationLabel: string | null;
  dropoff: LatLng | null;
}

/** POST /v1/logistics/shipments/:id/assign */
export interface AssignResult {
  id: string;
  orderId: string;
  status: 'assigned';
  riderId: string;
  trackingToken: string;
}

/** POST /v1/logistics/shipments/:id/dispatch: oferta automática al mejor motorizado (por ntfy a su app). */
export interface DispatchResult {
  offerId: string;
  riderId: string;
  expiresAt: string;
}

/** GET /v1/logistics/shipments/:id/proofs: prueba de entrega subida desde la app del motorizado. */
export interface DeliveryProof {
  id: string;
  proofType: 'photo' | 'signature' | 'otp' | 'id_check';
  receiverName: string | null;
  otpVerified: boolean | null;
  distanceToDestinationM: number | null;
  capturedAt: string;
  fileUrl: string | null;
}

export const PROOF_LABEL: Record<string, string> = { photo: 'Foto', signature: 'Firma', otp: 'Código de entrega', id_check: 'Documento' };

/** Estados desde los que se puede asignar (tracking.ts: pending y ready_for_pickup; assigned = reasignar). */
export const ASSIGNABLE_STATUSES = ['pending', 'ready_for_pickup', 'assigned'] as const;

export function formatSlot(slot: Slot | null): string {
  if (!slot) return 'Sin franja';
  return `${formatDate(slot.startsAt)} ${formatTime(slot.startsAt)}–${formatTime(slot.endsAt)}`;
}

/** Minutos desde que se creó el envío (antigüedad en la cola). */
export function ageMinutes(createdAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - time(createdAt)) / 60_000));
}

// ---------------------------------------------------------------- Liquidaciones
export type SettlementStatus = 'draft' | 'approved' | 'paid' | 'disputed';

export const SETTLEMENT_STATUS: Record<SettlementStatus, [string, Tone]> = {
  draft: ['Borrador', 'neutral'],
  approved: ['Aprobada', 'info'],
  paid: ['Pagada', 'ok'],
  disputed: ['En disputa', 'warn'],
};

export interface Settlement {
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
  paidAt: string | null;
}

export interface SettlementItem {
  shipmentId: string;
  orderId: string;
  deliveredAt: string | null;
  distanceM: number | null;
  codMethod: string | null;
  fee: string;
  codAmount: string;
}

export interface CodControl {
  codBalance: string;
  codLimit: string;
  codAvailable: string;
  overLimit: boolean;
}

export interface SettlementDetail extends Settlement {
  items: SettlementItem[];
  cod: CodControl;
}

export interface GenerateResult {
  period: { start: string; end: string };
  created: number;
  updated: number;
  removed: number;
  skipped: number;
  codLimitExceeded: string[];
  failed: { riderId: string; code: string; message: string }[];
}

export interface RiderRating {
  id: string;
  shipmentId: string;
  raterType: string;
  score: number;
  tags: string[] | null;
  comment: string | null;
  createdAt: string;
}

export interface RiderRatings {
  riderId: string;
  ratingAvg: string | null;
  ratingCount: number;
  ratings: RiderRating[];
}

export const COD_METHOD_LABEL: Record<string, string> = {
  cash: 'Efectivo',
  card_pos: 'Tarjeta (POS)',
  deuna_qr: 'Deuna (QR)',
};

/** Transiciones (domain/settlement.ts): draft → approved|disputed; disputed → approved; approved → paid. */
export function settlementActions(status: SettlementStatus): { approve: boolean; dispute: boolean; markPaid: boolean } {
  return { approve: status === 'draft' || status === 'disputed', dispute: status === 'draft', markPaid: status === 'approved' };
}

/** Mismo formato que el DTO (ApproveSettlementDto): hasta 10 enteros y 2 decimales. */
export const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;

/** "12,5" o "12.5" → "12.50"; null si no es un monto válido no negativo. */
export function normalizeMoneyInput(raw: string): string | null {
  const s = raw.trim().replace(',', '.');
  if (!MONEY_RE.test(s)) return null;
  return Number(s).toFixed(2);
}

export interface SettlementTotals {
  count: number;
  deliveries: number;
  grossFees: number;
  bonuses: number;
  deductions: number;
  codCollected: number;
  codRemitted: number;
  netPayable: number;
}

/** Sumas en centavos para no acumular errores de coma flotante; se devuelven en dólares. */
export function settlementTotals(list: Settlement[]): SettlementTotals {
  const cents = (v: string) => Math.round((toNumber(v) ?? 0) * 100);
  const acc = { grossFees: 0, bonuses: 0, deductions: 0, codCollected: 0, codRemitted: 0, netPayable: 0 };
  let deliveries = 0;
  for (const s of list) {
    deliveries += s.deliveriesCount;
    for (const k of Object.keys(acc) as (keyof typeof acc)[]) acc[k] += cents(s[k]);
  }
  return {
    count: list.length,
    deliveries,
    grossFees: acc.grossFees / 100,
    bonuses: acc.bonuses / 100,
    deductions: acc.deductions / 100,
    codCollected: acc.codCollected / 100,
    codRemitted: acc.codRemitted / 100,
    netPayable: acc.netPayable / 100,
  };
}

// ---------------------------------------------------------------- Semanas (lunes a domingo, fechas AAAA-MM-DD)
function parseIsoDate(d: string): Date {
  return new Date(`${d}T00:00:00Z`);
}

export function addDaysIso(d: string, days: number): string {
  const date = parseIsoDate(d);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Lunes de la semana que contiene la fecha. */
export function mondayOf(d: string): string {
  const dow = parseIsoDate(d).getUTCDay(); // 0 = domingo
  return addDaysIso(d, -((dow + 6) % 7));
}

/** Lunes de la semana anterior a `today` (la última semana cerrada). */
export function lastClosedWeek(today: string): string {
  return mondayOf(addDaysIso(today, -7));
}

/** Las `count` últimas semanas cerradas, de la más reciente a la más vieja. */
export function recentWeeks(today: string, count: number): string[] {
  const first = lastClosedWeek(today);
  return Array.from({ length: count }, (_, i) => addDaysIso(first, -7 * i));
}

/** "29 sept 2026 – 5 oct 2026" (mediodía UTC = misma fecha en Guayaquil). */
export function formatWeek(start: string, end: string = addDaysIso(start, 6)): string {
  return `${formatDate(`${start}T12:00:00Z`)} – ${formatDate(`${end}T12:00:00Z`)}`;
}
