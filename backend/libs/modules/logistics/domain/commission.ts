import { toCents, ValidationError } from '../../../shared-kernel';

/**
 * Esquema de comisión del motorizado (logistics.riders.commission_scheme, jsonb):
 *
 *   { "per_delivery": 2.50, "per_km": 0.30,
 *     "bonus_tiers": [{ "min_deliveries": 40, "amount": 10 }, { "min_deliveries": 80, "amount": 25 }] }
 *
 * - per_delivery: fijo por entrega completada.
 * - per_km: por km de la ruta bodega → destino (shipments.distance_m), hacia arriba a 0,1 km como la tarifa
 *   que paga el cliente (rider-pricing).
 * - bonus_tiers (opcional): bono semanal por volumen; se paga el MAYOR tramo alcanzado, no la suma.
 * Los montos aceptan número o string con hasta 2 decimales.
 */
export interface BonusTier {
  minDeliveries: number;
  amountCents: number;
}

export interface CommissionScheme {
  perDeliveryCents: number;
  perKmCents: number;
  bonusTiers: BonusTier[];
}

export class InvalidCommissionSchemeError extends ValidationError {
  constructor(reason: string, details: Record<string, unknown> = {}) {
    super('INVALID_COMMISSION_SCHEME', `Esquema de comisión inválido: ${reason}`, details);
  }
}

function money(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' && typeof value !== 'string') throw new InvalidCommissionSchemeError(`${field} debe ser un monto`, { field });
  try {
    return toCents(value);
  } catch {
    throw new InvalidCommissionSchemeError(`${field} debe ser un monto no negativo con hasta 2 decimales`, { field, value });
  }
}

export function parseCommissionScheme(raw: unknown): CommissionScheme {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidCommissionSchemeError('debe ser un objeto');
  const s = raw as Record<string, unknown>;
  const perDeliveryCents = money(s.per_delivery, 'per_delivery');
  const perKmCents = money(s.per_km, 'per_km');
  if (perDeliveryCents === 0 && perKmCents === 0) throw new InvalidCommissionSchemeError('per_delivery y per_km no pueden ser ambos 0');

  const rawTiers = s.bonus_tiers ?? [];
  if (!Array.isArray(rawTiers)) throw new InvalidCommissionSchemeError('bonus_tiers debe ser una lista');
  const bonusTiers = rawTiers.map((t, i) => {
    const tier = (t ?? {}) as Record<string, unknown>;
    const minDeliveries = tier.min_deliveries;
    if (typeof minDeliveries !== 'number' || !Number.isInteger(minDeliveries) || minDeliveries < 1) {
      throw new InvalidCommissionSchemeError(`bonus_tiers[${i}].min_deliveries debe ser un entero >= 1`);
    }
    return { minDeliveries, amountCents: money(tier.amount, `bonus_tiers[${i}].amount`) };
  });
  return { perDeliveryCents, perKmCents, bonusTiers };
}

/** Km cobrables de una entrega: hacia arriba a 0,1 km. Sin distancia registrada, 0 km. */
export function billableKm(distanceM: number | null): number {
  return Math.max(0, Math.ceil((distanceM ?? 0) / 100 - 1e-9)) / 10;
}

/** Comisión de una entrega, en centavos. */
export function deliveryFeeCents(scheme: CommissionScheme, distanceM: number | null): number {
  return scheme.perDeliveryCents + Math.round(billableKm(distanceM) * scheme.perKmCents);
}

/** Bono por volumen del período: el mayor tramo cuyo mínimo se alcanzó. */
export function volumeBonusCents(scheme: CommissionScheme, deliveries: number): number {
  return scheme.bonusTiers.filter((t) => deliveries >= t.minDeliveries).reduce((max, t) => Math.max(max, t.amountCents), 0);
}
