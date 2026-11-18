import { toCents, ValidationError } from '../../../shared-kernel';
import { MultiPolygon } from './geo';

export const DELIVERY_MODES = ['rider', 'courier', 'both'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** Zona de cobertura (logistics.coverage_zones). Montos numeric(12,2) como string, IVA incluido. */
export interface CoverageZone {
  id: string;
  tenantId: string;
  name: string;
  city: string;
  area: MultiPolygon;
  deliveryMode: DeliveryMode;
  /** Menor = gana cuando un punto cae en zonas superpuestas. */
  priority: number;
  baseFee: string;
  feePerKm: string;
  feePerExtraKg: string;
  maxWeightKg: number;
  /** Envío del motorizado gratis desde este total de mercadería (IVA incluido). */
  freeShippingThreshold: string | null;
  /** 'HH:MM' en America/Guayaquil: después de esa hora no se toman franjas del mismo día. */
  sameDayCutoff: string | null;
  /** Bodega que despacha a la zona: origen de la distancia del motorizado. */
  servingWarehouseId: string | null;
  active: boolean;
}

export type ZoneProps = Omit<CoverageZone, 'id' | 'tenantId'>;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:00)?$/;

/** '14:00' o '14:00:00' (como lo devuelve PostgreSQL) → '14:00'. */
export function normalizeTime(value: string, field: string): string {
  const m = TIME_RE.exec(value.trim());
  if (!m) throw new ValidationError('INVALID_TIME', `${field} debe tener el formato HH:MM`, { [field]: value });
  return `${m[1]}:${m[2]}`;
}

/** Motorizado propio posible en la zona (la regla completa está en delivery-rules). */
export function servesRiders(zone: Pick<CoverageZone, 'deliveryMode' | 'active'>): boolean {
  return zone.active && zone.deliveryMode !== 'courier';
}

/** Reglas de la zona completa (al crear y después de aplicar un PATCH). */
export function assertValidZone(z: ZoneProps): void {
  if (!z.name.trim()) throw new ValidationError('INVALID_ZONE', 'La zona necesita un nombre');
  if (!z.city.trim()) throw new ValidationError('INVALID_ZONE', 'La zona necesita una ciudad');
  if (!Number.isInteger(z.priority) || z.priority < 0 || z.priority > 10_000) {
    throw new ValidationError('INVALID_ZONE', 'La prioridad debe ser un entero entre 0 y 10000');
  }
  for (const [field, value] of [
    ['baseFee', z.baseFee],
    ['feePerKm', z.feePerKm],
    ['feePerExtraKg', z.feePerExtraKg],
    ...(z.freeShippingThreshold !== null ? [['freeShippingThreshold', z.freeShippingThreshold]] : []),
  ] as [string, string][]) {
    toCents(value); // lanza INVALID_MONEY si no es un monto válido
    if (field === 'freeShippingThreshold' && toCents(value) === 0) {
      throw new ValidationError('INVALID_ZONE', 'El umbral de envío gratis debe ser mayor que 0 (o null)');
    }
  }
  if (!(z.maxWeightKg > 0 && z.maxWeightKg <= 1000)) {
    throw new ValidationError('INVALID_ZONE', 'El peso máximo debe estar entre 0 y 1000 kg');
  }
  if (z.deliveryMode !== 'courier' && !z.servingWarehouseId) {
    throw new ValidationError(
      'SERVING_WAREHOUSE_REQUIRED',
      'Una zona con motorizado propio necesita la bodega que la atiende (origen de la distancia)',
    );
  }
}
