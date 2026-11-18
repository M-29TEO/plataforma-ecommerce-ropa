'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { ZoneForm } from '@/components/admin/ZoneForm';
import { type ZoneEditSession, ZoneMap } from '@/components/admin/ZoneMap';
import { ZoneSlots } from '@/components/admin/ZoneSlots';
import { useCan } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/providers/ToastProvider';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, QueryState } from '@/components/ui/States';
import {
  countVertices,
  DELIVERY_MODE_LABEL,
  MAX_AREA_VERTICES,
  polygonsOf,
  type PolygonCoords,
  toArea,
  validateArea,
  type WarehouseOption,
  type Zone,
  zoneColor,
  type ZoneFields,
} from '@/lib/admin';
import { api } from '@/lib/api/client';
import { formatMoney, formatInt } from '@/lib/format';

type Mode = 'idle' | 'create' | 'edit-area' | 'edit-data';

const ZONES_KEY = ['logistics', 'zones', 'list'] as const;

/**
 * Zonas de cobertura: todas en el mapa, alta dibujando el polígono, edición del área y de las
 * tarifas, desactivación (borrado lógico) y franjas horarias de cada zona.
 */
export default function ZonesPage() {
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const canWrite = can('logistics.zone.write');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [mode, setMode] = useState<Mode>('idle');
  const [session, setSession] = useState<ZoneEditSession | null>(null);
  const [polygons, setPolygons] = useState<PolygonCoords[]>([]);
  const [tab, setTab] = useState<'datos' | 'franjas'>('datos');
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [seq, setSeq] = useState(0);

  const zones = useQuery({
    queryKey: ZONES_KEY,
    queryFn: ({ signal }) => api<Zone[]>('/logistics/zones', { signal }),
  });
  const warehouses = useQuery({
    queryKey: ['inventory', 'warehouses', { active: true }],
    queryFn: ({ signal }) => api<WarehouseOption[]>('/inventory/warehouses', { query: { active: true }, signal }),
    enabled: can('inventory.read'),
    staleTime: 5 * 60_000,
  });

  const all = useMemo(() => zones.data ?? [], [zones.data]);
  // Memorizado: el mapa repinta las capas solo cuando cambia la lista, no en cada trazo del editor.
  const visible = useMemo(() => all.filter((z) => showInactive || z.active || z.id === selectedId), [all, showInactive, selectedId]);
  const selected = all.find((z) => z.id === selectedId) ?? null;
  const area = toArea(polygons);
  const areaErrors = validateArea(area);
  const warehouseList = can('inventory.read') ? (warehouses.data ?? []) : null;
  const warehouseName = (id: string | null) => (id ? (warehouses.data?.find((w) => w.id === id)?.name ?? `${id.slice(0, 8)}…`) : '—');

  function startSession(zone: Zone | null) {
    const n = seq + 1;
    setSeq(n);
    setPolygons(zone ? polygonsOf(zone.area) : []);
    setSession({ key: `${zone?.id ?? 'nueva'}:${n}`, zoneId: zone?.id ?? null, initial: zone ? polygonsOf(zone.area) : [] });
  }

  function stopEditing() {
    setSession(null);
    setPolygons([]);
    setMode('idle');
  }

  const onSaved = (zone: Zone, message: string) => {
    toast.ok(message);
    qc.setQueryData<Zone[]>(ZONES_KEY, (list) => (list ? (list.some((z) => z.id === zone.id) ? list.map((z) => (z.id === zone.id ? zone : z)) : [...list, zone]) : list));
    void qc.invalidateQueries({ queryKey: ['logistics', 'zones'] });
    setSelectedId(zone.id);
    stopEditing();
  };

  const create = useMutation({
    mutationFn: (fields: ZoneFields) => api<Zone>('/logistics/zones', { method: 'POST', body: { ...fields, area } }),
    onSuccess: (z) => onSaved(z, 'Zona creada'),
    onError: (e) => toast.error(e),
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api<Zone>(`/logistics/zones/${id}`, { method: 'PATCH', body }),
    onSuccess: (z, v) => onSaved(z, 'area' in v.body ? 'Área actualizada' : 'active' in v.body ? 'Zona reactivada' : 'Zona actualizada'),
    onError: (e) => toast.error(e),
  });
  const deactivate = useMutation({
    mutationFn: (id: string) => api<Zone>(`/logistics/zones/${id}`, { method: 'DELETE' }),
    onSuccess: (z) => {
      setConfirmDeactivate(false);
      onSaved(z, 'Zona desactivada');
    },
    onError: (e) => {
      setConfirmDeactivate(false);
      toast.error(e);
    },
  });

  const editingMap = mode === 'create' || mode === 'edit-area';

  return (
    <div>
      <PageHeader
        title="Zonas de cobertura"
        description="Áreas de entrega dibujadas en el mapa, con sus tarifas y franjas horarias"
        actions={
          canWrite &&
          mode === 'idle' && (
            <button
              className="btn-primary"
              onClick={() => {
                setSelectedId(null);
                setMode('create');
                startSession(null);
              }}
            >
              Nueva zona
            </button>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-[24rem_1fr]">
        <aside className="order-2 min-w-0 lg:order-1 lg:max-h-[calc(100dvh-11rem)] lg:overflow-y-auto">
          {mode === 'create' && (
            <section className="card space-y-4 p-4">
              <h2 className="font-semibold">Nueva zona</h2>
              <AreaStatus polygons={polygons} errors={areaErrors} />
              <ZoneForm
                warehouses={warehouseList}
                busy={create.isPending}
                submitLabel="Crear zona"
                extraError={() => (areaErrors.length ? areaErrors[0] : null)}
                onSubmit={(fields) => create.mutate(fields)}
                onCancel={stopEditing}
              />
            </section>
          )}

          {mode === 'edit-area' && selected && (
            <section className="card space-y-4 p-4">
              <h2 className="font-semibold">Editar área · {selected.name}</h2>
              <AreaStatus polygons={polygons} errors={areaErrors} />
              <div className="flex justify-end gap-2">
                <button className="btn-ghost" onClick={stopEditing} disabled={patch.isPending}>
                  Cancelar
                </button>
                <button
                  className="btn-primary"
                  disabled={patch.isPending || areaErrors.length > 0}
                  onClick={() => area && patch.mutate({ id: selected.id, body: { area } })}
                >
                  {patch.isPending ? 'Guardando…' : 'Guardar área'}
                </button>
              </div>
            </section>
          )}

          {mode === 'edit-data' && selected && (
            <section className="card space-y-4 p-4">
              <h2 className="font-semibold">Editar datos · {selected.name}</h2>
              <ZoneForm
                key={selected.id}
                zone={selected}
                warehouses={warehouseList}
                busy={patch.isPending}
                submitLabel="Guardar cambios"
                onSubmit={(fields) => patch.mutate({ id: selected.id, body: { ...fields } })}
                onCancel={stopEditing}
              />
            </section>
          )}

          {mode === 'idle' && selected && (
            <section className="card p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <button className="mb-1 text-xs text-ink-soft hover:text-ink" onClick={() => setSelectedId(null)}>
                    ← Todas las zonas
                  </button>
                  <h2 className="font-semibold">{selected.name}</h2>
                  <p className="text-xs text-ink-soft">{selected.city}</p>
                </div>
                {selected.active ? <Badge tone="ok">Activa</Badge> : <Badge>Inactiva</Badge>}
              </div>

              <div className="mt-3 flex gap-1 border-b border-line" role="tablist">
                {(['datos', 'franjas'] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === t ? 'border-accent font-medium' : 'border-transparent text-ink-soft'}`}
                    onClick={() => setTab(t)}
                  >
                    {t === 'datos' ? 'Datos y tarifas' : 'Franjas horarias'}
                  </button>
                ))}
              </div>

              {tab === 'datos' ? (
                <>
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                    <Item label="Modo">{DELIVERY_MODE_LABEL[selected.deliveryMode]}</Item>
                    <Item label="Prioridad">{selected.priority}</Item>
                    <Item label="Bodega">{warehouseName(selected.servingWarehouseId)}</Item>
                    <Item label="Peso máximo">{selected.maxWeightKg} kg</Item>
                    <Item label="Tarifa base">{formatMoney(selected.baseFee)}</Item>
                    <Item label="Por km">{formatMoney(selected.feePerKm)}</Item>
                    <Item label="Por kg extra">{formatMoney(selected.feePerExtraKg)}</Item>
                    <Item label="Envío gratis desde">{selected.freeShippingThreshold ? formatMoney(selected.freeShippingThreshold) : 'No aplica'}</Item>
                    <Item label="Corte mismo día">{selected.sameDayCutoff ?? 'Sin corte'}</Item>
                    <Item label="Vértices">{formatInt(countVertices(selected.area))}</Item>
                  </dl>
                  {canWrite && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => {
                          setMode('edit-area');
                          startSession(selected);
                        }}
                      >
                        Editar área
                      </button>
                      <button className="btn-ghost btn-sm" onClick={() => setMode('edit-data')}>
                        Editar datos
                      </button>
                      {selected.active ? (
                        <button className="btn-danger btn-sm" onClick={() => setConfirmDeactivate(true)}>
                          Eliminar zona
                        </button>
                      ) : (
                        <button className="btn-ghost btn-sm" disabled={patch.isPending} onClick={() => patch.mutate({ id: selected.id, body: { active: true } })}>
                          Reactivar
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="mt-3">
                  <ZoneSlots key={selected.id} zone={selected} canWrite={canWrite} />
                </div>
              )}
            </section>
          )}

          {mode === 'idle' && !selected && (
            <section className="card p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Zonas</h2>
                <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                  <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
                  Mostrar inactivas
                </label>
              </div>
              <QueryState query={zones} loading="Cargando zonas…">
                {() =>
                  visible.length === 0 ? (
                    <EmptyState title="No hay zonas">{canWrite && 'Usa «Nueva zona» y dibuja el área en el mapa.'}</EmptyState>
                  ) : (
                    <ul className="divide-y divide-line">
                      {visible.map((z) => (
                        <li key={z.id}>
                          <button
                            className="flex w-full items-center gap-3 px-1 py-2 text-left hover:bg-sand/50"
                            onClick={() => {
                              setSelectedId(z.id);
                              setTab('datos');
                            }}
                          >
                            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: zoneColor(z) }} aria-hidden />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{z.name}</span>
                              <span className="block text-xs text-ink-soft">
                                {z.city} · {DELIVERY_MODE_LABEL[z.deliveryMode]} · {formatMoney(z.baseFee)}
                              </span>
                            </span>
                            {!z.active && <Badge>Inactiva</Badge>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                }
              </QueryState>
            </section>
          )}
        </aside>

        <div className="order-1 min-w-0 lg:order-2">
          <ZoneMap
            zones={visible}
            selectedId={selectedId}
            onSelect={(id) => {
              if (mode !== 'idle') return;
              setSelectedId(id);
              setTab('datos');
            }}
            editing={editingMap ? session : null}
            onChange={setPolygons}
          />
          <p className="mt-2 flex flex-wrap gap-4 text-xs text-ink-soft">
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm" style={{ background: zoneColor({ active: true }) }} aria-hidden /> Activa
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm" style={{ background: zoneColor({ active: false }) }} aria-hidden /> Inactiva
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-accent" aria-hidden /> En edición
            </span>
          </p>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeactivate && !!selected}
        title="Eliminar zona"
        confirmLabel="Eliminar"
        busy={deactivate.isPending}
        onClose={() => setConfirmDeactivate(false)}
        onConfirm={() => selected && deactivate.mutate(selected.id)}
      >
        <p>
          La zona <strong>{selected?.name}</strong> dejará de ofrecer entregas: las direcciones dentro de ella quedarán sin cobertura (salvo que otra
          zona las cubra).
        </p>
        <p className="text-ink-soft">Es un borrado lógico: los pedidos y envíos históricos la conservan y puedes reactivarla después.</p>
      </ConfirmDialog>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Estado del área dibujada: polígonos, vértices y problemas que impiden guardar. */
function AreaStatus({ polygons, errors }: { polygons: PolygonCoords[]; errors: string[] }) {
  const area = toArea(polygons);
  const vertices = area ? countVertices(area) : 0;
  return (
    <div className="rounded-md border border-line bg-sand/40 p-3 text-sm">
      <p>
        {polygons.length === 0
          ? 'Dibuja el área en el mapa: clic para cada vértice y clic en el primero para cerrar.'
          : `${polygons.length} polígono(s) · ${formatInt(vertices)} de ${formatInt(MAX_AREA_VERTICES)} vértices`}
      </p>
      {polygons.length > 0 && errors.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-danger" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {polygons.length > 0 && errors.length === 0 && <p className="mt-1 text-ok">El área es válida.</p>}
    </div>
  );
}
