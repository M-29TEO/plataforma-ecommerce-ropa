/**
 * Configuración fijada al construir (EXPO_PUBLIC_*; ver .env.example). La API va detrás de Caddy,
 * que fija el tenant (X-Tenant-Id) por dominio: la app no lo conoce ni lo envía.
 */
const trim = (url: string) => url.replace(/\/+$/, '');

export const API_URL = `${trim(process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2/api')}/v1`;
export const MAP_TILES: 'osm' | 'pmtiles' = process.env.EXPO_PUBLIC_MAP_TILES === 'pmtiles' ? 'pmtiles' : 'osm';
export const PMTILES_URL = process.env.EXPO_PUBLIC_PMTILES_URL || '';

/** Centro por defecto del mapa (Quito) mientras no hay posición. */
export const DEFAULT_CENTER = { lat: -0.1807, lng: -78.4678 };

/** Cada cuánto se envía la posición durante el turno (el pedido: entre 10 y 15 s). */
export const GPS_INTERVAL_MS = 10_000;
/** Tope de reenvío: la API rechaza posiciones de más de 1 hora (POSITION_OUT_OF_RANGE). */
export const GPS_MAX_AGE_MS = 55 * 60_000;
export const GPS_QUEUE_MAX = 300;
