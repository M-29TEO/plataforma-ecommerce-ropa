'use client';

import type { Map as MlMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_CENTER, MAP_TILES } from '@/lib/config';
import { mapStyle } from '@/lib/map-style';

type Maplibre = typeof import('maplibre-gl');

let pmtilesReady = false;

/**
 * Crea un mapa de MapLibre en el contenedor. MapLibre se carga solo en el navegador (usa WebGL)
 * y con import dinámico, así no pesa en las páginas que no tienen mapa.
 */
export function useMap(opts: { center?: { lat: number; lng: number } | null; zoom?: number; interactive?: boolean } = {}) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MlMap | null>(null);
  const [lib, setLib] = useState<Maplibre | null>(null);
  const [failed, setFailed] = useState(false);
  const initial = useRef(opts);

  useEffect(() => {
    let cancelled = false;
    let instance: MlMap | null = null;
    (async () => {
      try {
        const maplibre = await import('maplibre-gl');
        // Worker copiado a public/ (scripts/copy-maplibre-worker.mjs): el que MapLibre ubica por
        // import.meta.url no existe en el bundle de Next. public/ se sirve bajo el basePath /admin.
        maplibre.setWorkerUrl(`/admin/maplibre-gl-worker.mjs?v=${maplibre.getVersion()}`);
        if (MAP_TILES === 'pmtiles' && !pmtilesReady) {
          const { Protocol } = await import('pmtiles');
          maplibre.addProtocol('pmtiles', new Protocol().tile);
          pmtilesReady = true;
        }
        if (cancelled || !container.current) return;
        const c = initial.current.center ?? DEFAULT_CENTER;
        instance = new maplibre.Map({
          container: container.current,
          style: mapStyle(),
          center: [c.lng, c.lat],
          zoom: initial.current.zoom ?? 14,
          interactive: initial.current.interactive ?? true,
          attributionControl: { compact: true },
          cooperativeGestures: false,
        });
        instance.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
        instance.on('load', () => {
          if (!cancelled) {
            setLib(maplibre);
            setMap(instance);
          }
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      instance?.remove();
    };
  }, []);

  return { container, map, lib, failed };
}
