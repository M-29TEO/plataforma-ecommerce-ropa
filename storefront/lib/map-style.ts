import { layers, namedFlavor } from '@protomaps/basemaps';
import type { StyleSpecification } from 'maplibre-gl';
import { MAP_TILES, PMTILES_URL } from './config';

/** Fuentes de las etiquetas del estilo de Protomaps (assets públicos del proyecto; se pueden autoalojar). */
const GLYPHS = process.env.NEXT_PUBLIC_MAP_GLYPHS || 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';

/**
 * Estilo de MapLibre. Con PMTiles (producción): mapa vectorial de Ecuador desde un solo archivo
 * estático (/tiles/ecuador.pmtiles, protocolo pmtiles://). Sin él (desarrollo): teselas raster de
 * OpenStreetMap con su atribución obligatoria.
 */
export function mapStyle(): StyleSpecification {
  if (MAP_TILES === 'pmtiles') {
    const url = PMTILES_URL.startsWith('http') ? PMTILES_URL : `${typeof window === 'undefined' ? '' : window.location.origin}${PMTILES_URL}`;
    return {
      version: 8,
      glyphs: GLYPHS,
      sources: {
        protomaps: { type: 'vector', url: `pmtiles://${url}`, attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>' },
      },
      layers: layers('protomaps', namedFlavor('light'), { lang: 'es' }),
    } as StyleSpecification;
  }
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  };
}
