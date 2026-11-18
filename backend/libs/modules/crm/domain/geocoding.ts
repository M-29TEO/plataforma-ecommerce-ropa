import { AddressFields, GeocodeAccuracy, GeoPoint, isInEcuador } from './address';

/**
 * Resultado normalizado de un geocodificador (Nominatim u otro detrás de GeocoderPort).
 * kind: 'house' si el resultado es un número de casa, 'street' si es una vía, 'area' si es un
 * barrio, parroquia o algo más grande.
 */
export interface GeocodeCandidate extends GeoPoint {
  kind: 'house' | 'street' | 'area';
  displayName: string;
  /** Ciudad, pueblo o cantón del resultado (para descartar homónimos de otra ciudad). */
  city: string | null;
  province: string | null;
  neighborhood: string | null;
}

/** Una consulta al geocodificador: estructurada (campos) o de texto libre. */
export type GeocodeAttempt =
  | { type: 'structured'; street: string; city: string; state: string; accuracy: GeocodeAccuracy }
  | { type: 'free'; q: string; accuracy: GeocodeAccuracy };

export type GeocodeQuery = Pick<AddressFields, 'province' | 'city' | 'parish' | 'neighborhood' | 'mainStreet' | 'crossStreet' | 'houseNumber'>;

/** "Pichincha", " PICHINCHA", "Galápagos" → "pichincha", "galapagos" (para comparar nombres). */
export function normalizePlace(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Consultas en cascada, de la más precisa a la menos. Las direcciones de Ecuador suelen ser una
 * intersección ("Av. Amazonas N34-120 y Naciones Unidas") y la nomenclatura N34-120 rara vez está
 * en OpenStreetMap, así que:
 *  1. calle principal con número (estructurada) → precisión 'rooftop' si el resultado es una casa;
 *  2. calle principal en la ciudad (estructurada) → 'street';
 *  3. barrio o parroquia en la ciudad (texto libre) → 'approximate'.
 * No se usa la ciudad sola: su centroide no sirve para cotizar ni entregar.
 */
export function buildGeocodeAttempts(q: GeocodeQuery): GeocodeAttempt[] {
  const attempts: GeocodeAttempt[] = [];
  const base = { city: q.city, state: q.province };
  if (q.houseNumber) attempts.push({ type: 'structured', street: `${q.houseNumber} ${q.mainStreet}`, ...base, accuracy: 'rooftop' });
  attempts.push({ type: 'structured', street: q.mainStreet, ...base, accuracy: 'street' });
  const area = q.neighborhood ?? q.parish;
  if (area) attempts.push({ type: 'free', q: `${area}, ${q.city}, ${q.province}, Ecuador`, accuracy: 'approximate' });
  return attempts;
}

/**
 * Elige el primer candidato creíble (el geocodificador ya los ordena por relevancia): dentro de
 * Ecuador y en la ciudad pedida (o la ciudad aparece en su nombre completo, porque Nominatim a
 * veces reporta la parroquia como ciudad). La precisión nunca es mejor que lo que el candidato es:
 * un resultado de barrio en el intento 1 vale 'approximate', no 'rooftop'.
 */
export function pickCandidate(
  candidates: readonly GeocodeCandidate[],
  query: Pick<GeocodeQuery, 'city'>,
  attempt: GeocodeAttempt,
): { point: GeoPoint; accuracy: GeocodeAccuracy; displayName: string } | null {
  const city = normalizePlace(query.city);
  for (const c of candidates) {
    if (!isInEcuador(c)) continue;
    const sameCity = normalizePlace(c.city) === city || normalizePlace(c.displayName).includes(city);
    if (!sameCity) continue;
    return { point: { lat: c.lat, lng: c.lng }, accuracy: degrade(attempt.accuracy, c.kind), displayName: c.displayName };
  }
  return null;
}

const RANK: Record<GeocodeAccuracy, number> = { user_pin: 3, rooftop: 2, street: 1, approximate: 0 };
const KIND_ACCURACY: Record<GeocodeCandidate['kind'], GeocodeAccuracy> = { house: 'rooftop', street: 'street', area: 'approximate' };

function degrade(expected: GeocodeAccuracy, kind: GeocodeCandidate['kind']): GeocodeAccuracy {
  const actual = KIND_ACCURACY[kind];
  return RANK[actual] < RANK[expected] ? actual : expected;
}
