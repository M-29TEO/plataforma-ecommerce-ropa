'use client';

import type { GeoJSONSource, Marker } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { appendTrail, bounds, ease, lerp, type Point } from '@/lib/tracking';
import { pinElement, riderElement, storeElement } from '../map/markers';
import { useMap } from '../map/useMap';

const ANIMATION_MS = 1600;

/**
 * Mapa del seguimiento: destino, bodega de origen y el motorizado, que se desliza entre una
 * posición y la siguiente (requestAnimationFrame) y deja su recorrido dibujado.
 */
export function TrackingMap({ destination, origin, rider }: { destination: Point | null; origin: Point | null; rider: (Point & { heading: number | null }) | null }) {
  const { container, map, lib, failed } = useMap({ center: destination, zoom: 14 });
  const riderMarker = useRef<{ marker: Marker; setHeading(d: number | null): void } | null>(null);
  const shown = useRef<Point | null>(null);
  const trail = useRef<Point[]>([]);
  const frame = useRef<number | null>(null);
  const fitted = useRef(false);

  // Destino, origen y capa del recorrido (una vez).
  useEffect(() => {
    if (!map || !lib) return;
    const markers: Marker[] = [];
    if (destination) markers.push(new lib.Marker({ element: pinElement('#1f1b16', 'Destino'), anchor: 'bottom' }).setLngLat([destination.lng, destination.lat]).addTo(map));
    if (origin) markers.push(new lib.Marker({ element: storeElement() }).setLngLat([origin.lng, origin.lat]).addTo(map));
    if (!map.getSource('trail')) {
      map.addSource('trail', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } } });
      map.addLayer({ id: 'trail', type: 'line', source: 'trail', paint: { 'line-color': '#b4532a', 'line-width': 4, 'line-opacity': 0.7 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    }
    return () => markers.forEach((m) => m.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, lib]);

  // Motorizado: se crea al llegar la primera posición y se anima hacia cada nueva.
  useEffect(() => {
    if (!map || !lib) return;
    if (!rider) {
      riderMarker.current?.marker.remove();
      riderMarker.current = null;
      shown.current = null;
      return;
    }
    if (!riderMarker.current) {
      const r = riderElement();
      riderMarker.current = { marker: new lib.Marker({ element: r.el }).setLngLat([rider.lng, rider.lat]).addTo(map), setHeading: r.setHeading };
      shown.current = { lat: rider.lat, lng: rider.lng };
    }
    riderMarker.current.setHeading(rider.heading);

    const from = shown.current ?? rider;
    const to = { lat: rider.lat, lng: rider.lng };
    const start = performance.now();
    if (frame.current) cancelAnimationFrame(frame.current);
    const step = (t: number) => {
      const p = lerp(from, to, ease((t - start) / ANIMATION_MS));
      shown.current = p;
      riderMarker.current?.marker.setLngLat([p.lng, p.lat]);
      if (t - start < ANIMATION_MS) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);

    trail.current = appendTrail(trail.current, to);
    (map.getSource('trail') as GeoJSONSource | undefined)?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: trail.current.map((p) => [p.lng, p.lat]) },
    });

    // Encuadre inicial: motorizado y destino; después el visitante mueve el mapa a su gusto.
    if (!fitted.current) {
      const b = bounds([to, destination]);
      if (b) map.fitBounds(b, { padding: 80, maxZoom: 16, duration: 800 });
      fitted.current = true;
    }
  }, [map, lib, rider, destination]);

  useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current);
  }, []);

  return (
    <div className="relative h-[55vh] min-h-80 overflow-hidden rounded-2xl border border-line bg-sand lg:h-[70vh]">
      <div ref={container} className="h-full w-full" role="img" aria-label="Mapa con la ubicación del motorizado y el destino" />
      {failed && <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-ink-soft">No se pudo cargar el mapa. El estado del pedido se sigue actualizando.</p>}
    </div>
  );
}
