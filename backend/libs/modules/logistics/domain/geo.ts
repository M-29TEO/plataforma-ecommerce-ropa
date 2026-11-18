import { ValidationError } from '../../../shared-kernel';

/** Punto WGS84 (SRID 4326). */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Coordenadas GeoJSON de un MultiPolygon: polígonos → anillos → posiciones [lng, lat]. */
export type MultiPolygonCoordinates = number[][][][];

export interface MultiPolygon {
  type: 'MultiPolygon';
  coordinates: MultiPolygonCoordinates;
}

/** Una zona de reparto real tiene decenas o cientos de vértices; el tope acota el costo de ST_IsValid/ST_Covers. */
export const MAX_AREA_VERTICES = 2_000;

export class InvalidAreaError extends ValidationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_AREA', message, details);
  }
}

export function assertValidPoint(p: GeoPoint): void {
  if (!Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) {
    throw new ValidationError('INVALID_LOCATION', 'Latitud fuera de rango [-90, 90]', { lat: p.lat });
  }
  if (!Number.isFinite(p.lng) || p.lng < -180 || p.lng > 180) {
    throw new ValidationError('INVALID_LOCATION', 'Longitud fuera de rango [-180, 180]', { lng: p.lng });
  }
}

function isPosition(p: unknown): p is [number, number] {
  return (
    Array.isArray(p) &&
    (p.length === 2 || p.length === 3) &&
    typeof p[0] === 'number' &&
    typeof p[1] === 'number' &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1])
  );
}

function checkRing(ring: unknown, where: string): number[][] {
  if (!Array.isArray(ring) || ring.length < 4) {
    throw new InvalidAreaError(`${where}: un anillo necesita al menos 4 posiciones (el primero se repite al final)`);
  }
  const positions = ring.map((p, i) => {
    if (!isPosition(p)) throw new InvalidAreaError(`${where}, posición ${i}: se espera [longitud, latitud]`);
    const [lng, lat] = p;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      throw new InvalidAreaError(`${where}, posición ${i}: fuera de rango (¿se invirtió [lng, lat]?)`, { position: p });
    }
    return [lng, lat];
  });
  const [first, last] = [positions[0], positions[positions.length - 1]];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new InvalidAreaError(`${where}: el anillo no está cerrado (la última posición debe repetir la primera)`);
  }
  return positions;
}

function checkPolygon(polygon: unknown, where: string): number[][][] {
  if (!Array.isArray(polygon) || polygon.length === 0) throw new InvalidAreaError(`${where}: polígono sin anillos`);
  return polygon.map((ring, i) => checkRing(ring, i === 0 ? `${where}, anillo exterior` : `${where}, hueco ${i}`));
}

/**
 * Acepta un GeoJSON Polygon o MultiPolygon (también dentro de un Feature, como lo exportan
 * geojson.io o un editor de mapas) y lo devuelve como MultiPolygon, que es lo que guarda
 * coverage_zones.area. Valida la estructura; la validez topológica (auto-intersecciones)
 * la verifica PostGIS con ST_IsValid al guardar.
 */
export function normalizeArea(input: unknown): MultiPolygon {
  let geometry = input as { type?: unknown; coordinates?: unknown; geometry?: unknown } | null;
  if (geometry && typeof geometry === 'object' && geometry.type === 'Feature') {
    geometry = geometry.geometry as typeof geometry;
  }
  if (!geometry || typeof geometry !== 'object') throw new InvalidAreaError('Se espera un GeoJSON Polygon o MultiPolygon');

  let coordinates: MultiPolygonCoordinates;
  if (geometry.type === 'Polygon') {
    coordinates = [checkPolygon(geometry.coordinates, 'Polígono')];
  } else if (geometry.type === 'MultiPolygon') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
      throw new InvalidAreaError('MultiPolygon sin polígonos');
    }
    coordinates = geometry.coordinates.map((p, i) => checkPolygon(p, `Polígono ${i + 1}`));
  } else {
    throw new InvalidAreaError(`Tipo de geometría no soportado: ${String(geometry.type)} (usa Polygon o MultiPolygon)`);
  }

  const vertices = coordinates.flat(2).length;
  if (vertices > MAX_AREA_VERTICES) {
    throw new InvalidAreaError(`La zona tiene ${vertices} vértices; el máximo es ${MAX_AREA_VERTICES}`);
  }
  return { type: 'MultiPolygon', coordinates };
}

const EARTH_RADIUS_M = 6_371_008.8;

/** Distancia del gran círculo entre dos puntos (haversine), en metros. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Factor de sinuosidad: en ciudad la ruta por calles es ~30 % más larga que la línea recta.
 * Solo se usa cuando OSRM no responde, para no cobrar de menos.
 */
export const ROAD_DETOUR_FACTOR = 1.3;

export function estimatedRoadMeters(a: GeoPoint, b: GeoPoint): number {
  return Math.round(haversineMeters(a, b) * ROAD_DETOUR_FACTOR);
}

/** Mismo punto (las coordenadas viajan como JSON: se toleran diferencias de redondeo). */
export function samePoint(a: GeoPoint, b: GeoPoint, epsilon = 1e-6): boolean {
  return Math.abs(a.lat - b.lat) <= epsilon && Math.abs(a.lng - b.lng) <= epsilon;
}
