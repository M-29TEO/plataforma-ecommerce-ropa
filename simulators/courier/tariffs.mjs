// Tarifario del courier simulado. Es el tarifario "del courier": la tienda NO lo lee, cotiza por
// API. La tienda tiene su propia copia negociada en logistics.courier_rate_cards (seed del backend)
// y la usa como respaldo cuando la API no responde en 3 s. Por eso los valores coinciden a
// propósito, salvo el recargo por combustible que solo aplica la API (así se nota en la demo si
// una cotización vino de la API o del tarifario).
//
// Precios finales en USD, IVA incluido. Tramos de peso (kg facturable): (desde, hasta]; sobre el
// último tramo se cobra extraKg por cada kg adicional o fracción.

export const FUEL_SURCHARGE = 0.04;
/** Peso volumétrico: cm³ / 5000 (factor estándar de couriers terrestres). */
export const VOLUMETRIC_DIVISOR = 5000;

export const SERVICES = {
  ESTANDAR: { name: 'Estándar', maxWeightKg: 30 },
  EXPRESS: { name: 'Express 24 h', maxWeightKg: 15 },
};

/**
 * Grupos de destino respecto del ORIGEN:
 *   local      misma ciudad
 *   provincial misma provincia, otra ciudad
 *   principal  Guayas o Azuay (rutas troncales diarias)
 *   nacional   resto del Ecuador continental
 * Galápagos no tiene cobertura (el courier no devuelve cotización).
 */
export const TARIFFS = {
  ESTANDAR: {
    local: { bands: [[0, 2, 3.5], [2, 5, 4.5]], extraKg: 0.5, etaHours: 24 },
    provincial: { bands: [[0, 2, 4.5], [2, 5, 5.75]], extraKg: 0.75, etaHours: 48 },
    principal: { bands: [[0, 2, 6.0], [2, 5, 7.5]], extraKg: 1.0, etaHours: 48 },
    nacional: { bands: [[0, 2, 7.5], [2, 5, 9.5]], extraKg: 1.25, etaHours: 72 },
  },
  EXPRESS: {
    local: { bands: [[0, 2, 5.0], [2, 5, 6.5]], extraKg: 0.75, etaHours: 12 },
    provincial: { bands: [[0, 2, 6.5], [2, 5, 8.0]], extraKg: 1.0, etaHours: 24 },
    principal: { bands: [[0, 2, 8.5], [2, 5, 10.5]], extraKg: 1.25, etaHours: 24 },
    nacional: { bands: [[0, 2, 10.5], [2, 5, 13.0]], extraKg: 1.5, etaHours: 48 },
  },
};

const PRINCIPAL = new Set(['guayas', 'azuay']);
const NOT_SERVED = new Set(['galapagos']);

/** "Pichincha", "PICHINCHA ", "Galápagos" → "pichincha", "galapagos". */
export function normalizePlace(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export function destinationGroup(origin, destination) {
  const [oc, op] = [normalizePlace(origin.city), normalizePlace(origin.province)];
  const [dc, dp] = [normalizePlace(destination.city), normalizePlace(destination.province)];
  if (!dp || NOT_SERVED.has(dp)) return null;
  if (dc && dc === oc && dp === op) return 'local';
  if (dp === op) return 'provincial';
  if (PRINCIPAL.has(dp)) return 'principal';
  return 'nacional';
}

/** Mayor entre el peso real y el volumétrico, redondeado hacia arriba a 0,1 kg. */
export function chargeableWeightKg(weightKg, volumeCm3 = 0) {
  const w = Math.max(Number(weightKg) || 0, (Number(volumeCm3) || 0) / VOLUMETRIC_DIVISOR);
  return Math.ceil(Math.max(w, 0.1) * 10 - 1e-9) / 10;
}

/** Precio del tarifario (sin recargo) para un peso facturable; null si excede el servicio. */
export function tariffPrice(serviceCode, group, kg) {
  const service = SERVICES[serviceCode];
  const tariff = TARIFFS[serviceCode]?.[group];
  if (!service || !tariff || kg > service.maxWeightKg) return null;
  const band = tariff.bands.find(([from, to]) => kg > from && kg <= to);
  if (band) return { price: band[2], etaHours: tariff.etaHours };
  const [, lastTo, lastPrice] = tariff.bands[tariff.bands.length - 1];
  return { price: lastPrice + Math.ceil(kg - lastTo - 1e-9) * tariff.extraKg, etaHours: tariff.etaHours };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Cotización de la API: tarifario + recargo por combustible. Devuelve una opción por servicio
 * disponible (vacío si el destino no tiene cobertura o el paquete excede todos los servicios).
 */
export function quote({ origin, destination, weightKg, volumeCm3, services }) {
  const group = destinationGroup(origin ?? {}, destination ?? {});
  if (!group) return { group: null, chargeableKg: null, options: [] };
  const kg = chargeableWeightKg(weightKg, volumeCm3);
  const wanted = Array.isArray(services) && services.length > 0 ? services : Object.keys(SERVICES);
  const options = [];
  for (const code of wanted) {
    const t = tariffPrice(code, group, kg);
    if (!t) continue;
    options.push({
      serviceCode: code,
      serviceName: SERVICES[code].name,
      price: round2(t.price * (1 + FUEL_SURCHARGE)).toFixed(2),
      currency: 'USD',
      etaHours: t.etaHours,
      breakdown: { tariff: t.price.toFixed(2), fuelSurcharge: round2(t.price * FUEL_SURCHARGE).toFixed(2) },
    });
  }
  return { group, chargeableKg: kg, options };
}
