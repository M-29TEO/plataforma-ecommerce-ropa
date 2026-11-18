'use client';

import type { GeoJSONSource, Marker } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { pinElement, riderElement } from '@/components/map/markers';
import { useMap } from '@/components/map/useMap';
import { isStale, type LatLng, type LiveRider, PRESENCE_COLOR, PRESENCE_LABEL } from '@/lib/logistics';

export interface MapDestination extends LatLng {
  id: string;
  label: string;
}

interface RiderMarker {
  marker: Marker;
  ctl: ReturnType<typeof riderElement>;
  target: LatLng;
  frame: number | null;
}

const LINES = 'logistics-lines';
const ANIMATION_MS = 900;

/**
 * Mapa de motorizados: un marcador por motorizado con posición (color por presencia, flecha
 * con el rumbo, atenuado si lleva más de 5 min sin reportar) que se desliza a cada posición
 * nueva. Opcionalmente, destinos (pines) y líneas rectas motorizado → destino.
 */
export function RidersMap({
  riders,
  selectedId = null,
  onSelect,
  destinations = [],
  lines = [],
  focus = null,
  fitKey,
  zoom = 12,
  className = 'h-[60dvh]',
  label = 'Mapa de motorizados',
}: {
  riders: LiveRider[];
  selectedId?: string | null;
  onSelect?: (riderId: string) => void;
  destinations?: MapDestination[];
  lines?: [LatLng, LatLng][];
  /** Punto al que centrar el mapa (cambia la referencia para volver a centrar). */
  focus?: LatLng | null;
  /** Al cambiar, encuadra todos los puntos visibles. */
  fitKey?: string;
  zoom?: number;
  className?: string;
  label?: string;
}) {
  const { container, map, lib, failed } = useMap({ zoom });
  const markers = useRef(new Map<string, RiderMarker>());
  const pins = useRef<Marker[]>([]);
  const selectCb = useRef(onSelect);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    selectCb.current = onSelect;
  });

  // Reevalúa "sin reportar > 5 min" aunque no lleguen eventos.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Marcadores de motorizados.
  useEffect(() => {
    if (!map || !lib) return;
    const seen = new Set<string>();
    for (const r of riders) {
      const loc = r.lastLocation;
      if (!loc) continue;
      seen.add(r.riderId);
      let m = markers.current.get(r.riderId);
      if (!m) {
        const ctl = riderElement();
        ctl.el.style.cursor = 'pointer';
        ctl.el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          selectCb.current?.(r.riderId);
        });
        const marker = new lib.Marker({ element: ctl.el }).setLngLat([loc.lng, loc.lat]).addTo(map);
        m = { marker, ctl, target: { lat: loc.lat, lng: loc.lng }, frame: null };
        markers.current.set(r.riderId, m);
      } else if (m.target.lat !== loc.lat || m.target.lng !== loc.lng) {
        animate(m, { lat: loc.lat, lng: loc.lng });
      }
      m.ctl.setColor(PRESENCE_COLOR[r.presence]);
      m.ctl.setHeading(loc.heading);
      m.ctl.setDimmed(isStale(loc, now));
      m.ctl.el.title = `${r.name ?? 'Motorizado'} · ${PRESENCE_LABEL[r.presence][0]}`;
      const selected = r.riderId === selectedId;
      m.ctl.el.style.zIndex = selected ? '5' : '';
      m.ctl.el.style.filter = selected ? 'drop-shadow(0 0 6px rgba(31,27,22,.8))' : '';
    }
    for (const [id, m] of markers.current) {
      if (seen.has(id)) continue;
      if (m.frame) cancelAnimationFrame(m.frame);
      m.marker.remove();
      markers.current.delete(id);
    }
  }, [map, lib, riders, selectedId, now]);

  // Limpieza al desmontar.
  useEffect(() => {
    const all = markers.current;
    const allPins = pins;
    return () => {
      for (const m of all.values()) {
        if (m.frame) cancelAnimationFrame(m.frame);
        m.marker.remove();
      }
      all.clear();
      for (const p of allPins.current) p.remove();
    };
  }, []);

  // Destinos.
  const destKey = destinations.map((d) => `${d.id}:${d.lat},${d.lng}`).join('|');
  useEffect(() => {
    if (!map || !lib) return;
    for (const p of pins.current) p.remove();
    pins.current = destinations.map((d) => new lib.Marker({ element: pinElement('#2b5c8a', d.label), anchor: 'bottom' }).setLngLat([d.lng, d.lat]).addTo(map));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- destKey resume los destinos
  }, [map, lib, destKey]);

  // Líneas rectas motorizado → destino.
  const linesKey = JSON.stringify(lines);
  useEffect(() => {
    if (!map) return;
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: lines.map(([a, b]) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] } })),
    };
    const source = map.getSource(LINES) as GeoJSONSource | undefined;
    if (source) source.setData(data);
    else {
      map.addSource(LINES, { type: 'geojson', data });
      map.addLayer({ id: LINES, type: 'line', source: LINES, paint: { 'line-color': '#2b5c8a', 'line-width': 2, 'line-dasharray': [2, 2] } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- linesKey resume las líneas
  }, [map, linesKey]);

  // Centrar en un punto.
  useEffect(() => {
    if (map && focus) map.easeTo({ center: [focus.lng, focus.lat], zoom: Math.max(map.getZoom(), 14), duration: 600 });
  }, [map, focus]);

  // Encuadrar todo lo visible.
  useEffect(() => {
    if (!map || !lib || fitKey === undefined) return;
    const points: LatLng[] = [...riders.flatMap((r) => (r.lastLocation ? [r.lastLocation] : [])), ...destinations];
    if (points.length === 0) return;
    if (points.length === 1) {
      map.jumpTo({ center: [points[0].lng, points[0].lat], zoom: 14 });
      return;
    }
    const bounds = new lib.LngLatBounds([points[0].lng, points[0].lat], [points[0].lng, points[0].lat]);
    for (const p of points) bounds.extend([p.lng, p.lat]);
    map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 0 });
    // Solo cuando cambia fitKey: las posiciones nuevas no deben mover la cámara.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, lib, fitKey]);

  return (
    <div className={`relative overflow-hidden rounded-lg border border-line bg-sand ${className}`}>
      <div ref={container} className="absolute inset-0" role="region" aria-label={label} />
      {failed && <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-ink-soft">No se pudo cargar el mapa (WebGL no disponible).</p>}
    </div>
  );
}

/** Desliza el marcador a la posición nueva (interpolación lineal con easing). */
function animate(m: RiderMarker, to: LatLng) {
  if (m.frame) cancelAnimationFrame(m.frame);
  const fromLL = m.marker.getLngLat();
  const from = { lat: fromLL.lat, lng: fromLL.lng };
  m.target = to;
  // Saltos grandes (> ~2 km) no se animan: sería un "vuelo" engañoso.
  if (Math.abs(from.lat - to.lat) + Math.abs(from.lng - to.lng) > 0.02 || typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    m.marker.setLngLat([to.lng, to.lat]);
    m.frame = null;
    return;
  }
  const start = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / ANIMATION_MS);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    m.marker.setLngLat([from.lng + (to.lng - from.lng) * e, from.lat + (to.lat - from.lat) * e]);
    m.frame = k < 1 ? requestAnimationFrame(step) : null;
  };
  m.frame = requestAnimationFrame(step);
}
