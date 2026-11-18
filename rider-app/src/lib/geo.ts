import type { GeoPoint } from './types';

/** [oeste, sur, este, norte] que contiene los puntos, con un mínimo de ~300 m para no acercar de más. */
export function boundsFor(points: GeoPoint[], minSpanDeg = 0.003): [number, number, number, number] | null {
  if (points.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of points) {
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  const padLng = Math.max(0, minSpanDeg - (east - west)) / 2;
  const padLat = Math.max(0, minSpanDeg - (north - south)) / 2;
  return [west - padLng, south - padLat, east + padLng, north + padLat];
}

/** Distancia en línea recta (haversine), en metros. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** El backend exige estar a menos de 300 m del destino para entregar (MAX_DELIVERY_DISTANCE_M). */
export const MAX_DELIVERY_DISTANCE_M = 300;
