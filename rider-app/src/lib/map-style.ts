import { layers, namedFlavor } from '@protomaps/basemaps';
import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import { MAP_TILES, PMTILES_URL } from './config';

const GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
const OSM_ATTRIBUTION = '© OpenStreetMap';

/**
 * Mismo criterio que el storefront: con PMTiles, mapa vectorial de Ecuador desde un solo archivo
 * servido por Caddy (MapLibre Native entiende pmtiles://); sin él, teselas raster de OpenStreetMap
 * (solo para desarrollo, con su atribución).
 */
export function mapStyle(): StyleSpecification {
  if (MAP_TILES === 'pmtiles' && PMTILES_URL) {
    return {
      version: 8,
      glyphs: GLYPHS,
      sources: { protomaps: { type: 'vector', url: `pmtiles://${PMTILES_URL}`, attribution: OSM_ATTRIBUTION } },
      layers: layers('protomaps', namedFlavor('light'), { lang: 'es' }),
    } as StyleSpecification;
  }
  return {
    version: 8,
    sources: {
      osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: OSM_ATTRIBUTION },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  };
}
