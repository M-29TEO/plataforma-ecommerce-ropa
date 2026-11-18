import { InvalidAddressError, LocationOutOfCoverageError } from './errors';

export const GEOCODE_ACCURACIES = ['rooftop', 'street', 'approximate', 'user_pin'] as const;
export type GeocodeAccuracy = (typeof GEOCODE_ACCURACIES)[number];

export const MAX_ADDRESSES_PER_USER = 10;

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Campos que escribe el cliente (crm.addresses). */
export interface AddressFields {
  label: string | null;
  recipientName: string;
  recipientPhone: string;
  province: string;
  city: string;
  parish: string | null;
  neighborhood: string | null;
  mainStreet: string;
  crossStreet: string | null;
  houseNumber: string | null;
  reference: string | null;
}

export interface AddressProps extends AddressFields {
  id: string;
  tenantId: string;
  userId: string;
  location: GeoPoint | null;
  geocodeAccuracy: GeocodeAccuracy | null;
  isDefault: boolean;
  createdAt: Date;
}

const LIMITS: Record<keyof AddressFields, { min: number; max: number }> = {
  label: { min: 1, max: 40 },
  recipientName: { min: 2, max: 120 },
  recipientPhone: { min: 7, max: 20 },
  province: { min: 2, max: 80 },
  city: { min: 2, max: 80 },
  parish: { min: 1, max: 80 },
  neighborhood: { min: 1, max: 120 },
  mainStreet: { min: 2, max: 200 },
  crossStreet: { min: 1, max: 200 },
  houseNumber: { min: 1, max: 20 },
  reference: { min: 1, max: 300 },
};

const REQUIRED: ReadonlyArray<keyof AddressFields> = ['recipientName', 'recipientPhone', 'province', 'city', 'mainStreet'];
/** Celular (09xxxxxxxx), fijo con código de provincia (02xxxxxxx) o internacional (+593...). */
const PHONE_RE = /^\+?\d{7,15}$/;

function clean(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text === '' ? null : text;
}

/** Recorta espacios, valida largos y obligatorios. Los opcionales vacíos quedan en null. */
export function normalizeAddressFields(input: Partial<Record<keyof AddressFields, unknown>>): AddressFields {
  const out = {} as Record<keyof AddressFields, string | null>;
  for (const key of Object.keys(LIMITS) as Array<keyof AddressFields>) {
    const value = clean(input[key]);
    if (value === null) {
      if (REQUIRED.includes(key)) throw new InvalidAddressError(`Falta ${key}`, key);
      out[key] = null;
      continue;
    }
    const { min, max } = LIMITS[key];
    if (value.length < min || value.length > max) throw new InvalidAddressError(`${key} debe tener entre ${min} y ${max} caracteres`, key);
    out[key] = value;
  }
  const phone = out.recipientPhone!.replace(/[\s-]/g, '');
  if (!PHONE_RE.test(phone)) throw new InvalidAddressError('recipientPhone debe ser un teléfono válido (solo dígitos, 7 a 15)', 'recipientPhone');
  out.recipientPhone = phone;
  return out as unknown as AddressFields;
}

/**
 * Cajas de Ecuador continental y de Galápagos (un poco holgadas en los bordes). Un pin fuera
 * de ellas es un error de quien lo marcó (o lat/lng invertidos).
 */
const ECUADOR_BOXES = [
  { minLat: -5.05, maxLat: 1.7, minLng: -81.15, maxLng: -75.15 },
  { minLat: -1.55, maxLat: 1.75, minLng: -92.1, maxLng: -89.15 },
];

export function isInEcuador(p: GeoPoint): boolean {
  return ECUADOR_BOXES.some((b) => p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng);
}

export function assertPinInEcuador(p: GeoPoint): GeoPoint {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !isInEcuador(p)) throw new LocationOutOfCoverageError(p.lat, p.lng);
  // 6 decimales ≈ 11 cm: más precisión es ruido del GPS.
  return { lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 };
}

/**
 * Estado de la ubicación para el cliente:
 *  - needsPin: sin ubicación, no se puede cotizar el envío hasta marcarla en el mapa.
 *  - pinRecommended: ubicación aproximada (calle o barrio); conviene confirmarla con un pin.
 */
export function locationStatus(a: Pick<AddressProps, 'location' | 'geocodeAccuracy'>): { needsPin: boolean; pinRecommended: boolean } {
  if (!a.location) return { needsPin: true, pinRecommended: true };
  return { needsPin: false, pinRecommended: a.geocodeAccuracy === 'street' || a.geocodeAccuracy === 'approximate' };
}

/** Si alguno de estos campos cambia, la ubicación geocodificada deja de valer. */
export const LOCATION_FIELDS: ReadonlyArray<keyof AddressFields> = ['province', 'city', 'parish', 'neighborhood', 'mainStreet', 'crossStreet', 'houseNumber'];

export function locationFieldsChanged(before: AddressFields, after: AddressFields): boolean {
  return LOCATION_FIELDS.some((k) => (before[k] ?? null) !== (after[k] ?? null));
}
