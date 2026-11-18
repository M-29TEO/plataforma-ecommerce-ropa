import { registerDecorator, ValidationOptions } from 'class-validator';
import { MAX_AREA_VERTICES } from '../../domain/geo';

/** Profundidad de anidación de coordinates según el tipo: Polygon = anillos → posiciones → números. */
const DEPTH = { Polygon: 3, MultiPolygon: 4 } as const;

/**
 * Recorre coordinates contando vértices sin construir nada: corta apenas pasa del máximo, encuentra
 * algo que no sea número o un número fuera de [lng, lat]. Devuelve false si la forma no sirve.
 */
function walk(node: unknown, depth: number, counter: { n: number }): boolean {
  if (!Array.isArray(node)) return false;
  if (depth === 1) {
    // Posición [lng, lat] (o [lng, lat, alt], que el dominio descarta).
    if (node.length < 2 || node.length > 3 || !node.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
    const [lng, lat] = node as number[];
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return false;
    return ++counter.n <= MAX_AREA_VERTICES;
  }
  if (node.length === 0) return false;
  return node.every((child) => walk(child, depth - 1, counter));
}

function isBoundedGeometry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const g = value as { type?: unknown; coordinates?: unknown };
  if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return false;
  // Solo type y coordinates: nada de "properties" ni miembros extra de tamaño libre.
  if (Object.keys(g).some((k) => k !== 'type' && k !== 'coordinates')) return false;
  return walk(g.coordinates, DEPTH[g.type], { n: 0 });
}

/**
 * Área de cobertura acotada antes de llegar al dominio: GeoJSON Polygon o MultiPolygon (o un
 * Feature con una de esas geometrías, como lo exporta geojson.io; sus properties se ignoran y
 * deben ser chicas), coordenadas numéricas dentro de rango y como máximo MAX_AREA_VERTICES
 * vértices. Así un cuerpo enorme o arbitrario no llega a normalizeArea ni a PostGIS. Que los
 * anillos cierren y no se crucen lo siguen validando el dominio y ST_IsValid (422 INVALID_AREA).
 */
export function IsBoundedGeoJsonArea(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'isBoundedGeoJsonArea',
      target: target.constructor,
      propertyName: String(propertyName),
      options: {
        message: `area debe ser un GeoJSON Polygon o MultiPolygon con hasta ${MAX_AREA_VERTICES} vértices [lng, lat] en rango`,
        ...options,
      },
      validator: {
        validate(value: unknown): boolean {
          if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'Feature') {
            const f = value as { geometry?: unknown; properties?: unknown };
            const props = f.properties ?? null;
            if (props !== null && (typeof props !== 'object' || JSON.stringify(props).length > 2048)) return false;
            return isBoundedGeometry(f.geometry);
          }
          return isBoundedGeometry(value);
        },
      },
    });
}
