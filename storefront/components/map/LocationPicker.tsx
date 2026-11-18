'use client';

import type { Marker } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { pinElement } from './markers';
import { useMap } from './useMap';

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Selección de la dirección en el mapa: un pin que se arrastra o se mueve tocando el mapa, y el
 * botón "usar mi ubicación" (GPS del teléfono). El punto es lo que usa Logística para la zona y la
 * tarifa, así que manda sobre el texto de la dirección.
 */
export function LocationPicker({ value, onChange, height = 320 }: { value: LatLng | null; onChange: (p: LatLng) => void; height?: number }) {
  const { container, map, lib, failed } = useMap({ center: value, zoom: value ? 17 : 13 });
  const marker = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  useEffect(() => {
    if (!map || !lib) return;
    const m = new lib.Marker({ element: pinElement(), draggable: true, anchor: 'bottom' });
    if (value) m.setLngLat([value.lng, value.lat]).addTo(map);
    m.on('dragend', () => {
      const p = m.getLngLat();
      onChangeRef.current({ lat: round(p.lat), lng: round(p.lng) });
    });
    map.on('click', (e) => {
      m.setLngLat(e.lngLat).addTo(map);
      onChangeRef.current({ lat: round(e.lngLat.lat), lng: round(e.lngLat.lng) });
    });
    marker.current = m;
    return () => {
      m.remove();
    };
    // value solo se usa al crear el marcador; los cambios externos los sigue el efecto de abajo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, lib]);

  // Cuando el punto cambia desde afuera (geocodificación, GPS), se mueve el pin y el mapa.
  useEffect(() => {
    if (!map || !marker.current || !value) return;
    const cur = marker.current.getLngLat?.();
    if (cur && Math.abs(cur.lat - value.lat) < 1e-6 && Math.abs(cur.lng - value.lng) < 1e-6) return;
    marker.current.setLngLat([value.lng, value.lat]).addTo(map);
    map.easeTo({ center: [value.lng, value.lat], zoom: Math.max(map.getZoom(), 16) });
  }, [map, value]);

  function locate() {
    if (!navigator.geolocation) {
      setGeoError('Tu navegador no permite ubicarte.');
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        onChange({ lat: round(pos.coords.latitude), lng: round(pos.coords.longitude) });
      },
      () => {
        setLocating(false);
        setGeoError('No pudimos obtener tu ubicación. Mueve el pin en el mapa.');
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  return (
    <div>
      <div className="relative overflow-hidden rounded-xl border border-line bg-sand" style={{ height }}>
        <div ref={container} className="h-full w-full" role="application" aria-label="Mapa: toca o arrastra el pin hasta tu puerta" />
        {failed && <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-ink-soft">No se pudo cargar el mapa en este navegador.</p>}
        <button type="button" onClick={locate} disabled={locating} className="absolute bottom-3 left-3 rounded-full bg-white px-3 py-2 text-xs font-medium shadow">
          {locating ? 'Ubicando…' : '📍 Usar mi ubicación'}
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-soft">{value ? 'Ajusta el pin exactamente en tu puerta: así el motorizado llega sin llamar.' : 'Toca el mapa para marcar tu puerta.'}</p>
      {geoError && <p className="mt-1 text-xs text-danger">{geoError}</p>}
    </div>
  );
}

/** 6 decimales ≈ 11 cm: suficiente y evita ruido de coma flotante. */
const round = (n: number) => Math.round(n * 1e6) / 1e6;
