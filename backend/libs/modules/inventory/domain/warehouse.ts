import { ValidationError } from '../../../shared-kernel';

export const WAREHOUSE_TYPES = ['warehouse', 'store', 'dark_store'] as const;
export type WarehouseType = (typeof WAREHOUSE_TYPES)[number];

/** Punto WGS84 (SRID 4326). Se guarda como geography(Point, 4326). */
export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Warehouse {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  type: WarehouseType;
  address: Record<string, unknown>;
  location: GeoPoint;
  city: string;
  isPickupPoint: boolean;
  shipsOnline: boolean;
  active: boolean;
}

export function assertValidPoint(p: GeoPoint): void {
  if (!Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) {
    throw new ValidationError('INVALID_LOCATION', 'Latitud fuera de rango [-90, 90]', { lat: p.lat });
  }
  if (!Number.isFinite(p.lng) || p.lng < -180 || p.lng > 180) {
    throw new ValidationError('INVALID_LOCATION', 'Longitud fuera de rango [-180, 180]', { lng: p.lng });
  }
}

/** Códigos cortos y estables, p. ej. "UIO-01": se usan en etiquetas y reportes. */
export function normalizeWarehouseCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(normalized)) {
    throw new ValidationError('INVALID_WAREHOUSE_CODE', 'El código debe tener 2-20 caracteres: letras, números, "-" o "_"');
  }
  return normalized;
}
