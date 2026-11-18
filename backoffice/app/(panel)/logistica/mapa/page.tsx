'use client';

import { useEffect, useMemo, useState } from 'react';
import { ConnectionBadge } from '@/components/logistica/ConnectionBadge';
import { type MapDestination, RidersMap } from '@/components/logistica/RidersMap';
import { CodMeter, RiderRow } from '@/components/logistica/RiderList';
import { useLiveRiders } from '@/components/logistica/useLiveRiders';
import { StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { formatDateTime } from '@/lib/format';
import {
  countByPresence,
  filterRiders,
  formatDistance,
  haversineMeters,
  type LatLng,
  type LiveRider,
  PRESENCE_LABEL,
  PRESENCES,
  type RiderPresence,
  SHIPMENT_STATUS,
} from '@/lib/logistics';

/**
 * Mapa en vivo: todos los motorizados con su última posición (socket /staff; respaldo por HTTP
 * cada 30 s) y, al elegir uno, sus envíos en curso con el destino y una línea recta hasta él.
 */
export default function LiveMapPage() {
  const { riders, connection } = useLiveRiders();
  const [search, setSearch] = useState('');
  const [presence, setPresence] = useState<RiderPresence | ''>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<LatLng | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const list = useMemo(() => riders.data ?? [], [riders.data]);
  const counts = useMemo(() => countByPresence(list), [list]);
  const visible = useMemo(() => filterRiders(list, search, presence), [list, search, presence]);
  const selected = list.find((r) => r.riderId === selectedId) ?? null;

  const select = (id: string) => {
    setSelectedId((cur) => (cur === id ? null : id));
    const r = list.find((x) => x.riderId === id);
    if (r?.lastLocation && id !== selectedId) setFocus({ lat: r.lastLocation.lat, lng: r.lastLocation.lng });
  };

  const destinations: MapDestination[] = selected
    ? selected.activeShipments.flatMap((s) => (s.dropoff ? [{ id: s.shipmentId, lat: s.dropoff.lat, lng: s.dropoff.lng, label: `Destino del envío ${s.orderId.slice(0, 8)}` }] : []))
    : [];
  const lines: [LatLng, LatLng][] = selected?.lastLocation ? destinations.map((d) => [selected.lastLocation!, d]) : [];
  const fitKey = riders.data ? 'cargado' : undefined;

  return (
    <div>
      <PageHeader
        title="Mapa en vivo"
        description="Motorizados en tiempo real y sus envíos en curso."
        actions={<ConnectionBadge state={connection} />}
      />
      {riders.error && !riders.data && <ErrorState error={riders.error} onRetry={() => void riders.refetch()} />}
      {riders.isPending && <div className="py-8"><Spinner label="Cargando motorizados…" /></div>}
      {riders.data && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0">
              <RidersMap
                riders={visible}
                selectedId={selectedId}
                onSelect={select}
                destinations={destinations}
                lines={lines}
                focus={focus}
                fitKey={fitKey}
                className="h-[55dvh] lg:h-[calc(100dvh-11rem)]"
              />
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft" aria-label="Leyenda">
                {PRESENCES.map((p) => (
                  <li key={p} className="flex items-center gap-1.5">
                    <StatusBadge status={p} map={PRESENCE_LABEL} />
                  </li>
                ))}
                <li>Atenuado: más de 5 min sin reportar</li>
              </ul>
            </div>

            <aside className="card flex min-h-0 flex-col p-3 lg:h-[calc(100dvh-11rem)]">
              <label htmlFor="rider-search" className="label">
                Buscar motorizado
              </label>
              <input id="rider-search" className="input" placeholder="Nombre, teléfono o placa" value={search} onChange={(e) => setSearch(e.target.value)} />
              <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por presencia">
                <FilterChip active={presence === ''} onClick={() => setPresence('')}>
                  Todos ({list.length})
                </FilterChip>
                {PRESENCES.map((p) => (
                  <FilterChip key={p} active={presence === p} onClick={() => setPresence(presence === p ? '' : p)}>
                    {PRESENCE_LABEL[p][0]} ({counts[p]})
                  </FilterChip>
                ))}
              </div>

              {selected && <SelectedRider rider={selected} onClose={() => setSelectedId(null)} />}

              <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
                {visible.length === 0 ? (
                  <EmptyState title="Sin motorizados">{list.length ? 'Ninguno coincide con el filtro.' : 'No hay motorizados activos.'}</EmptyState>
                ) : (
                  <ul className="space-y-2">
                    {visible.map((r) => (
                      <RiderRow key={r.riderId} rider={r} selected={r.riderId === selectedId} onSelect={() => select(r.riderId)} now={now} />
                    ))}
                  </ul>
                )}
              </div>
            </aside>
          </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`rounded-full border px-2.5 py-1 text-xs ${active ? 'border-ink bg-ink text-paper' : 'border-line bg-panel hover:border-ink'}`}>
      {children}
    </button>
  );
}

function SelectedRider({ rider, onClose }: { rider: LiveRider; onClose: () => void }) {
  const loc = rider.lastLocation;
  return (
    <section className="mt-3 rounded-md border border-ink/20 bg-sand/40 p-3" aria-label="Motorizado seleccionado">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{rider.name ?? 'Sin nombre'}</h2>
          <p className="text-xs text-ink-soft">
            {[rider.vehicleType, rider.plate, rider.phone].filter(Boolean).join(' · ') || '—'}
            {rider.ratingAvg && ` · ★ ${rider.ratingAvg}`}
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Cerrar detalle">
          ✕
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-soft">
        {loc ? `Última posición ${formatDateTime(loc.recordedAt)}${loc.speedKmh !== null ? ` · ${Math.round(loc.speedKmh)} km/h` : ''}` : 'Sin posición reciente'}
      </p>
      <CodMeter rider={rider} />
      <h3 className="mt-3 text-xs font-semibold tracking-wide text-ink-soft uppercase">Envíos en curso</h3>
      {rider.activeShipments.length === 0 ? (
        <p className="mt-1 text-xs text-ink-soft">Ninguno.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {rider.activeShipments.map((s) => (
            <li key={s.shipmentId} className="flex items-center justify-between gap-2 text-xs">
              <span className="font-mono">{s.orderId.slice(0, 8)}</span>
              <StatusBadge status={s.status} map={SHIPMENT_STATUS} />
              <span className="text-ink-soft">{s.dropoff ? (loc ? formatDistance(haversineMeters(loc, s.dropoff)) : 'Con destino') : 'Sin coordenadas'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
