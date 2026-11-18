'use client';

import type { Marker } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { useMap } from '@/components/map/useMap';
import { pinElement } from '@/components/map/markers';

/**
 * Mapa para fijar el punto de entrega: clic en el mapa coloca el pin y se puede arrastrar.
 * Sin WebGL el mapa no carga y se avisa (no se puede cotizar motorizado sin el punto).
 */
export function PinMap({ value, onChange }: { value: { lat: number; lng: number } | null; onChange: (p: { lat: number; lng: number }) => void }) {
  const { container, map, lib, failed } = useMap({ center: value, zoom: value ? 16 : 13 });
  const marker = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!map) return;
    const click = (e: { lngLat: { lat: number; lng: number } }) => onChangeRef.current({ lat: round(e.lngLat.lat), lng: round(e.lngLat.lng) });
    map.on('click', click);
    map.getCanvas().style.cursor = 'crosshair';
    return () => {
      map.off('click', click);
    };
  }, [map]);

  useEffect(() => {
    if (!map || !lib) return;
    if (!value) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    if (!marker.current) {
      const m = new lib.Marker({ element: pinElement(), draggable: true, anchor: 'bottom' }).setLngLat([value.lng, value.lat]).addTo(map);
      m.on('dragend', () => {
        const p = m.getLngLat();
        onChangeRef.current({ lat: round(p.lat), lng: round(p.lng) });
      });
      marker.current = m;
      map.easeTo({ center: [value.lng, value.lat], zoom: Math.max(map.getZoom(), 15) });
    } else {
      marker.current.setLngLat([value.lng, value.lat]);
    }
  }, [map, lib, value]);

  useEffect(
    () => () => {
      marker.current?.remove();
      marker.current = null;
    },
    [],
  );

  if (failed) {
    return (
      <p className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-warn" role="alert">
        No se pudo cargar el mapa en este navegador; no es posible fijar el punto de entrega.
      </p>
    );
  }
  return (
    <div>
      <div ref={container} className="h-72 w-full overflow-hidden rounded-lg border border-line bg-sand" role="application" aria-label="Mapa: haz clic para fijar el punto de entrega" />
      <p className="mt-1 text-xs text-ink-soft">
        {value ? `Punto fijado: ${value.lat.toFixed(5)}, ${value.lng.toFixed(5)} · arrástralo para ajustar.` : 'Haz clic en el mapa para fijar el punto de entrega.'}
      </p>
    </div>
  );
}

/** 6 decimales (~10 cm): suficiente y evita cotizaciones nuevas por ruido. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
