import { toCents } from '../../../shared-kernel';
import { normalizePlace } from './places';

/** Tarifa negociada con el courier (logistics.courier_rate_cards). */
export interface RateCard {
  id: string;
  courierServiceId: string;
  originCity: string;
  /** Provincia de destino o '*' (resto del país). */
  destProvince: string;
  /** Ciudad de destino; null = toda la provincia. */
  destCity: string | null;
  weightFromKg: number;
  weightToKg: number;
  price: string;
  extraKgPrice: string;
  validFrom: string;
  validTo: string | null;
}

/** dest_province = '*': tarifa para cualquier provincia sin una tarifa propia. */
export const ANY_PROVINCE = '*';

export interface RateCardQuery {
  originCity: string;
  destProvince: string;
  destCity: string | null;
  kg: number;
  /** Fecha local 'AAAA-MM-DD' para la vigencia. */
  date: string;
}

export interface RateCardPrice {
  rateCardId: string;
  priceCents: number;
}

/**
 * Precio desde el tarifario del servicio (respaldo del CourierQuoteAggregator):
 * 1. Tarifas vigentes y del mismo origen.
 * 2. La más específica gana: ciudad de destino > provincia completa > '*'.
 * 3. Tramo de peso (desde, hasta]; si el paquete excede el último tramo, se cobra ese tramo más
 *    extra_kg_price por cada kg adicional o fracción.
 * null si no hay tarifa (el servicio no cubre ese destino).
 */
export function priceFromRateCards(cards: RateCard[], q: RateCardQuery): RateCardPrice | null {
  const origin = normalizePlace(q.originCity);
  const province = normalizePlace(q.destProvince);
  const city = normalizePlace(q.destCity);
  const valid = cards.filter(
    (c) => normalizePlace(c.originCity) === origin && c.validFrom <= q.date && (c.validTo === null || c.validTo >= q.date),
  );
  const specificity = (c: RateCard): number => {
    const p = normalizePlace(c.destProvince);
    if (p === province && c.destCity !== null) return normalizePlace(c.destCity) === city ? 3 : 0;
    if (p === province) return 2;
    if (c.destProvince === ANY_PROVINCE) return 1;
    return 0;
  };
  const best = Math.max(0, ...valid.map(specificity));
  if (best === 0) return null;
  const bands = valid.filter((c) => specificity(c) === best).sort((a, b) => a.weightToKg - b.weightToKg);

  const band = bands.find((c) => q.kg > c.weightFromKg && q.kg <= c.weightToKg) ?? (q.kg <= bands[0].weightFromKg ? bands[0] : null);
  if (band) return { rateCardId: band.id, priceCents: toCents(band.price) };
  const top = bands[bands.length - 1];
  if (q.kg <= top.weightToKg) return null; // hueco entre tramos: tarifario mal cargado
  const extraKg = Math.ceil(q.kg - top.weightToKg - 1e-9);
  return { rateCardId: top.id, priceCents: toCents(top.price) + extraKg * toCents(top.extraKgPrice) };
}
