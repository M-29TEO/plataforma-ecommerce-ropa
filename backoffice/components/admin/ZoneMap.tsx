'use client';

import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { TerraDraw } from 'terra-draw';
import { useEffect, useRef, useState } from 'react';
import { useMap } from '@/components/map/useMap';
import { boundsOf, closeRing, type PolygonCoords, type Zone, zoneColor } from '@/lib/admin';

/** Sesión de edición del área: `key` distinto = sesión nueva (se recargan los polígonos iniciales). */
export interface ZoneEditSession {
  key: string;
  /** Zona cuya área se edita (null al crear una nueva). */
  zoneId: string | null;
  initial: PolygonCoords[];
}

type Tool = 'polygon' | 'select';

const SOURCE = 'admin-zones';
const FILL = 'admin-zones-fill';
const LINE = 'admin-zones-line';

/**
 * Mapa de zonas de cobertura: todas pintadas (verde activas, gris inactivas; la elegida resaltada)
 * y, durante una sesión de edición, Terra Draw para dibujar polígonos, mover, agregar o borrar
 * vértices y borrar polígonos. Terra Draw se importa dinámicamente: solo existe en el navegador.
 */
export function ZoneMap({
  zones,
  selectedId,
  onSelect,
  editing,
  onChange,
}: {
  zones: Zone[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  editing: ZoneEditSession | null;
  onChange: (polygons: PolygonCoords[]) => void;
}) {
  const { container, map, failed } = useMap({ zoom: 11 });
  const draw = useRef<TerraDraw | null>(null);
  const [tool, setTool] = useState<Tool>('polygon');
  const [picked, setPicked] = useState<string | number | null>(null);
  const [drawReady, setDrawReady] = useState(false);
  const [drawError, setDrawError] = useState('');
  const fitted = useRef(false);
  const callbacks = useRef({ onSelect, onChange });
  useEffect(() => {
    callbacks.current = { onSelect, onChange };
  });

  // Capas de las zonas (una vez por mapa).
  useEffect(() => {
    if (!map) return;
    if (!map.getSource(SOURCE)) {
      map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: FILL,
        type: 'fill',
        source: SOURCE,
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'selected'], 0.4, 0.18] },
      });
      map.addLayer({
        id: LINE,
        type: 'line',
        source: SOURCE,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['get', 'selected'], 3, 1.5],
          'line-dasharray': ['case', ['get', 'active'], ['literal', [1, 0]], ['literal', [2, 2]]],
        },
      });
    }
    const click = (e: MapLayerMouseEvent) => {
      if (draw.current) return; // editando: los clics son de Terra Draw
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === 'string') callbacks.current.onSelect(id);
    };
    const enter = () => {
      if (!draw.current) map.getCanvas().style.cursor = 'pointer';
    };
    const leave = () => {
      if (!draw.current) map.getCanvas().style.cursor = '';
    };
    map.on('click', FILL, click);
    map.on('mouseenter', FILL, enter);
    map.on('mouseleave', FILL, leave);
    return () => {
      map.off('click', FILL, click);
      map.off('mouseenter', FILL, enter);
      map.off('mouseleave', FILL, leave);
    };
  }, [map]);

  // Datos de las zonas (la que se está editando se oculta: la dibuja Terra Draw).
  useEffect(() => {
    if (!map) return;
    const editingId = editing?.zoneId ?? null;
    const features = zones
      .filter((z) => z.id !== editingId)
      .map((z) => ({
        type: 'Feature' as const,
        geometry: z.area,
        properties: { id: z.id, name: z.name, active: z.active, color: zoneColor(z), selected: z.id === selectedId },
      }));
    (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
    if (!fitted.current && zones.length > 0) {
      const b = boundsOf(zones.map((z) => z.area));
      if (b) map.fitBounds(b, { padding: 40, duration: 0, maxZoom: 14 });
      fitted.current = true;
    }
  }, [map, zones, selectedId, editing]);

  // Encuadra la zona elegida.
  useEffect(() => {
    if (!map || !selectedId || editing) return;
    const z = zones.find((x) => x.id === selectedId);
    const b = z && boundsOf([z.area]);
    if (b) map.fitBounds(b, { padding: 60, maxZoom: 15 });
    // Solo al cambiar de zona, no cada vez que se refrescan los datos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selectedId]);

  // Sesión de dibujo/edición con Terra Draw.
  const sessionKey = editing?.key ?? null;
  useEffect(() => {
    if (!map || !editing) return;
    let cancelled = false;
    let instance: TerraDraw | null = null;
    (async () => {
      try {
        const [td, { TerraDrawMapLibreGLAdapter }] = await Promise.all([import('terra-draw'), import('terra-draw-maplibre-gl-adapter')]);
        if (cancelled) return;
        const color = '#b4532a';
        instance = new td.TerraDraw({
          adapter: new TerraDrawMapLibreGLAdapter({ map }),
          modes: [
            new td.TerraDrawPolygonMode({
              // Durante el trazo se permite; al cerrar o mover un vértice no puede cruzarse.
              validation: (f, ctx) => (String(ctx.updateType) === 'provisional' ? { valid: true } : td.ValidateNotSelfIntersecting(f)),
              styles: { fillColor: color, outlineColor: color, fillOpacity: 0.25, outlineWidth: 2, closingPointColor: color },
            }),
            new td.TerraDrawSelectMode({
              flags: {
                polygon: {
                  feature: {
                    draggable: true,
                    validation: (f) => td.ValidateNotSelfIntersecting(f),
                    coordinates: { draggable: true, midpoints: true, deletable: true },
                  },
                },
              },
              styles: { selectedPolygonColor: color, selectedPolygonOutlineColor: color, selectionPointColor: color, midPointColor: '#ffffff', midPointOutlineColor: color },
            }),
          ],
        });
        instance.start();
        const initial = editing.initial.map((coordinates) => ({
          type: 'Feature' as const,
          geometry: { type: 'Polygon' as const, coordinates: coordinates.map(closeRing) },
          properties: { mode: 'polygon' },
        }));
        const results = initial.length ? instance.addFeatures(initial) : [];
        if (results.some((r) => !r.valid)) setDrawError('Parte del área actual no se puede editar en el mapa (¿huecos o vértices repetidos?). Puedes borrarla y dibujarla de nuevo.');
        else setDrawError('');

        const emit = () => {
          if (!instance) return;
          const polygons = instance
            .getSnapshot()
            .filter((f) => f.geometry.type === 'Polygon' && f.properties.mode === 'polygon' && !f.properties.currentlyDrawing)
            .map((f) => f.geometry.coordinates as PolygonCoords);
          callbacks.current.onChange(polygons);
        };
        instance.on('change', emit);
        instance.on('finish', (id, ctx) => {
          emit();
          if (ctx.mode !== 'polygon') return;
          // Al cerrar un polígono, pasa a edición con él elegido (para ajustar vértices).
          instance?.setMode('select');
          instance?.selectFeature(id);
          setTool('select');
        });
        instance.on('select', (id) => setPicked(id));
        instance.on('deselect', () => setPicked(null));

        const startTool: Tool = initial.length ? 'select' : 'polygon';
        instance.setMode(startTool);
        setTool(startTool);
        draw.current = instance;
        setDrawReady(true);
        emit();
      } catch {
        if (!cancelled) setDrawError('No se pudo cargar el editor de polígonos.');
      }
    })();
    return () => {
      cancelled = true;
      draw.current = null;
      setDrawReady(false);
      setPicked(null);
      try {
        instance?.stop();
      } catch {
        // El mapa ya pudo haberse desmontado.
      }
    };
    // La sesión depende solo de su clave: los polígonos iniciales se leen al empezar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, sessionKey]);

  function choose(t: Tool) {
    draw.current?.setMode(t);
    setTool(t);
  }

  function removePicked() {
    if (picked === null || !draw.current) return;
    draw.current.deselectFeature(picked);
    draw.current.removeFeatures([picked]);
    setPicked(null);
  }

  return (
    <div className="relative h-[60dvh] min-h-80 overflow-hidden rounded-lg border border-line lg:h-[calc(100dvh-11rem)]">
      <div ref={container} className="h-full w-full" />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-sand p-6 text-center text-sm text-ink-soft">
          No se pudo cargar el mapa (WebGL no disponible en este navegador).
        </div>
      )}
      {editing && drawReady && (
        <div className="absolute top-2 left-2 flex max-w-[calc(100%-4rem)] flex-col gap-2">
          <div className="flex flex-wrap gap-1 rounded-md bg-panel/95 p-1 shadow" role="toolbar" aria-label="Herramientas de dibujo">
            <button className={tool === 'polygon' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} aria-pressed={tool === 'polygon'} onClick={() => choose('polygon')}>
              Dibujar polígono
            </button>
            <button className={tool === 'select' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} aria-pressed={tool === 'select'} onClick={() => choose('select')}>
              Editar vértices
            </button>
            <button className="btn-danger btn-sm" disabled={picked === null} onClick={removePicked}>
              Borrar polígono
            </button>
          </div>
          <p className="rounded-md bg-panel/95 px-2 py-1 text-xs text-ink-soft shadow">
            {tool === 'polygon'
              ? 'Clic para agregar vértices; clic en el primero (o doble clic) para cerrar. Esc cancela el trazo.'
              : 'Clic en un polígono para elegirlo. Arrastra vértices para moverlos, los puntos medios para agregar uno y clic derecho sobre un vértice para borrarlo.'}
          </p>
          {drawError && (
            <p className="rounded-md bg-danger px-2 py-1 text-xs text-white shadow" role="alert">
              {drawError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
