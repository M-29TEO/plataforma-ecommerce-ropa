import { fromCents, toCents } from '../../../shared-kernel';
import { CoverageZone } from './zone';

/** Peso volumétrico: cm³ / 5000 (mismo factor que usan los couriers). */
export const VOLUMETRIC_DIVISOR = 5000;
/** Kilos incluidos en la tarifa base del motorizado; fee_per_extra_kg se cobra desde aquí. */
export const RIDER_INCLUDED_KG = 2;

/** Mayor entre el peso real y el volumétrico, en kg, redondeado hacia arriba a 0,1 kg. */
export function chargeableWeightKg(weightG: number, volumeCm3 = 0): number {
  const kg = Math.max(weightG / 1000, volumeCm3 / VOLUMETRIC_DIVISOR, 0.1);
  return Math.ceil(kg * 10 - 1e-9) / 10;
}

export interface RiderPriceInput {
  zone: Pick<CoverageZone, 'baseFee' | 'feePerKm' | 'feePerExtraKg' | 'freeShippingThreshold'>;
  distanceM: number;
  weightG: number;
  volumeCm3: number;
  /** Total de la mercadería (IVA incluido, después de descuentos) para el envío gratis. */
  merchandiseTotal: string;
}

export interface RiderPrice {
  /** Precio SIN el recargo de la franja (depende de la franja que elija el cliente). */
  priceCents: number;
  breakdown: {
    baseFee: string;
    distanceKm: number;
    distanceFee: string;
    chargeableKg: number;
    extraKg: number;
    weightFee: string;
    freeShipping: boolean;
  };
}

/**
 * RiderPricing: base + km × tarifa por km + kg extra × tarifa por kg extra.
 * - Los km se redondean hacia arriba a 0,1 km; los kg extra, a kg completos.
 * - Con envío gratis de la zona, la tarifa es 0 (el recargo de una franja premium se cobra igual).
 */
export function riderPrice(input: RiderPriceInput): RiderPrice {
  const { zone } = input;
  const distanceKm = Math.ceil(Math.max(0, input.distanceM) / 100 - 1e-9) / 10;
  const chargeableKg = chargeableWeightKg(input.weightG, input.volumeCm3);
  const extraKg = Math.max(0, Math.ceil(chargeableKg - RIDER_INCLUDED_KG - 1e-9));
  const base = toCents(zone.baseFee);
  const distanceFee = Math.round(distanceKm * toCents(zone.feePerKm));
  const weightFee = extraKg * toCents(zone.feePerExtraKg);
  const freeShipping =
    zone.freeShippingThreshold !== null && toCents(input.merchandiseTotal) >= toCents(zone.freeShippingThreshold);
  return {
    priceCents: freeShipping ? 0 : base + distanceFee + weightFee,
    breakdown: {
      baseFee: zone.baseFee,
      distanceKm,
      distanceFee: fromCents(distanceFee),
      chargeableKg,
      extraKg,
      weightFee: fromCents(weightFee),
      freeShipping,
    },
  };
}
