/**
 * Configuración del backoffice (variables NEXT_PUBLIC_*: se fijan al construir).
 *
 * Todo corre en el navegador del personal: el API se llama en el mismo dominio (/api/v1, Caddy) con
 * el access token en memoria. No hay render en el servidor con datos: las pantallas son privadas
 * y por usuario, así que no hay nada que cachear ni indexar.
 */
export const APP_NAME = process.env.NEXT_PUBLIC_STORE_NAME ? `${process.env.NEXT_PUBLIC_STORE_NAME} · Backoffice` : 'Moda · Backoffice';

/** Base del API (/api por Caddy; el API expone /v1). */
export const BROWSER_API = `${(process.env.NEXT_PUBLIC_API_URL || '/api').replace(/\/+$/, '')}/v1`;

/**
 * Solo desarrollo sin Caddy: tenant para las rutas anónimas (login). En Docker, Caddy fija y
 * reemplaza el header X-Tenant-Id, así que esta variable no se usa ni hace falta.
 */
export const DEV_TENANT_ID = process.env.NEXT_PUBLIC_DEV_TENANT_ID || '';

/** Socket.IO: mismo origen detrás de Caddy; en desarrollo, NEXT_PUBLIC_REALTIME_URL=http://localhost:3002. */
export const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL || undefined;
export const REALTIME_PATH = process.env.NEXT_PUBLIC_REALTIME_PATH || '/ws/socket.io';

/** Mapa base: 'pmtiles' (archivo de Ecuador servido por Caddy) u 'osm' (solo desarrollo). */
export const MAP_TILES = (process.env.NEXT_PUBLIC_MAP_TILES || 'osm') as 'pmtiles' | 'osm';
export const PMTILES_URL = process.env.NEXT_PUBLIC_PMTILES_URL || '/tiles/ecuador.pmtiles';

/** Centro por defecto de los mapas: Quito. */
export const DEFAULT_CENTER = { lat: -0.1807, lng: -78.4678 };

/** Zona horaria en la que se muestran las fechas (se guardan en UTC). */
export const STORE_TIME_ZONE = 'America/Guayaquil';
