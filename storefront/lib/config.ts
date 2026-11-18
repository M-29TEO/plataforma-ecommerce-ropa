/**
 * Configuración por variables de entorno.
 *
 * Servidor (SSR/ISR): llama a la API por la red interna (API_INTERNAL_URL) y fija el tenant de la
 * tienda (STORE_TENANT_ID), igual que Caddy lo fija para el navegador.
 * Navegador: mismo dominio, /api/v1 (Caddy, o el proxy de desarrollo de proxy.ts) y /ws para Socket.IO.
 */
export const STORE_NAME = process.env.NEXT_PUBLIC_STORE_NAME || 'Moda Demo';
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost').replace(/\/+$/, '');

/** Base del API para el navegador (/api por Caddy; el API expone /v1). */
export const BROWSER_API = `${(process.env.NEXT_PUBLIC_API_URL || '/api').replace(/\/+$/, '')}/v1`;

/** Socket.IO: mismo origen detrás de Caddy; en desarrollo, NEXT_PUBLIC_REALTIME_URL=http://localhost:3002. */
export const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL || undefined;
export const REALTIME_PATH = process.env.NEXT_PUBLIC_REALTIME_PATH || '/ws/socket.io';

/**
 * Mapa base. 'pmtiles': el archivo de Ecuador servido por Caddy en /tiles (docs/02-stack-open-source.md).
 * 'osm': teselas raster de openstreetmap.org, solo para desarrollo mientras no exista el .pmtiles
 * (su política de uso no admite tráfico de producción).
 */
export const MAP_TILES = (process.env.NEXT_PUBLIC_MAP_TILES || 'osm') as 'pmtiles' | 'osm';
export const PMTILES_URL = process.env.NEXT_PUBLIC_PMTILES_URL || '/tiles/ecuador.pmtiles';

/** Centro por defecto del mapa: Quito. */
export const DEFAULT_CENTER = { lat: -0.1807, lng: -78.4678 };

export function serverApiBase(): string {
  return (process.env.API_INTERNAL_URL || 'http://localhost:3000/v1').replace(/\/+$/, '');
}

export function storeTenantId(): string {
  const id = process.env.STORE_TENANT_ID;
  if (!id) throw new Error('Falta STORE_TENANT_ID (uuid del tenant de la tienda; lo imprime npm run seed:dev en el backend)');
  return id;
}
