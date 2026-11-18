'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectionBadge } from '@/components/logistica/ConnectionBadge';
import { RidersMap } from '@/components/logistica/RidersMap';
import { LIVE_RIDERS_KEY, POLL_MS, useLiveRiders } from '@/components/logistica/useLiveRiders';
import { useToast } from '@/components/providers/ToastProvider';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { EmptyState, ErrorState, QueryState } from '@/components/ui/States';
import { api, errorMessage, isApiError } from '@/lib/api/client';
import { formatMoney, formatRelative, toNumber } from '@/lib/format';
import {
  ageMinutes,
  type AssignResult,
  type DispatchResult,
  formatDistance,
  formatSlot,
  type LiveRider,
  PRESENCE_LABEL,
  rankRiders,
  SHIPMENT_STATUS,
  type ShipmentListItem,
} from '@/lib/logistics';
import type { Page } from '@/lib/types';

const LIMIT = 50;
const QUEUE_KEY = ['logistics', 'shipments', 'queue'] as const;
/** Motorizados que se dibujan en el mini mapa (los más cercanos con posición). */
const NEARBY_ON_MAP = 8;

/** ¿Con este envío el motorizado pasaría su tope de efectivo? (el API responde 409 RIDER_COD_LIMIT). */
function wouldExceedCod(rider: LiveRider, codAmount: string | null): boolean {
  const limit = toNumber(rider.codLimit);
  if (limit === null) return false;
  return (toNumber(rider.codBalance) ?? 0) + (toNumber(codAmount) ?? 0) > limit;
}

/**
 * Despacho: cola de envíos con motorizado pendientes o listos para retirar, oferta automática a la
 * app del motorizado (ntfy) y asignación manual, con los motorizados ordenados por disponibilidad y
 * por distancia en línea recta al destino.
 */
export default function DispatchPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [riderId, setRiderId] = useState<string | null>(null);

  const onShipmentStatus = useCallback(() => void qc.invalidateQueries({ queryKey: QUEUE_KEY }), [qc]);
  const { riders, connection } = useLiveRiders({ onShipmentStatus });

  const queue = useQuery({
    queryKey: [...QUEUE_KEY, offset],
    queryFn: ({ signal }) =>
      api<Page<ShipmentListItem>>('/logistics/shipments', {
        query: { status: ['pending', 'ready_for_pickup'], carrierType: 'rider', limit: LIMIT, offset },
        signal,
      }),
    refetchInterval: POLL_MS,
    placeholderData: (prev) => prev,
  });

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const items = useMemo(() => queue.data?.items ?? [], [queue.data]);
  const selected = items.find((s) => s.id === selectedId) ?? null;
  // Si el envío sale de la cola (otro despachador lo asignó), `selected` queda en null y el panel se cierra.

  const ranked = useMemo(() => (selected ? rankRiders(riders.data ?? [], selected.dropoff) : []), [selected, riders.data]);
  const nearby = useMemo(
    () =>
      ranked
        .filter((r) => r.rider.lastLocation)
        .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity))
        .slice(0, NEARBY_ON_MAP)
        .map((r) => r.rider),
    [ranked],
  );

  const assign = useMutation({
    mutationFn: (v: { shipmentId: string; riderId: string }) => api<AssignResult>(`/logistics/shipments/${v.shipmentId}/assign`, { method: 'POST', body: { riderId: v.riderId } }),
    onSuccess: (_r, v) => {
      const name = riders.data?.find((r) => r.riderId === v.riderId)?.name ?? 'el motorizado';
      toast.ok(`Envío asignado a ${name}.`);
      setSelectedId(null);
      setRiderId(null);
      void qc.invalidateQueries({ queryKey: QUEUE_KEY });
      void qc.invalidateQueries({ queryKey: LIVE_RIDERS_KEY });
    },
    onError: (e) => {
      if (isApiError(e, 'SHIPMENT_INVALID_TRANSITION')) {
        toast.error(`El envío ya no se puede asignar (cambió de estado). ${errorMessage(e)}`);
        setSelectedId(null);
        setRiderId(null);
        void qc.invalidateQueries({ queryKey: QUEUE_KEY });
      } else if (isApiError(e, 'RIDER_COD_LIMIT')) {
        toast.error(`El motorizado superaría su tope de efectivo: elige otro. ${errorMessage(e)}`);
      } else toast.error(e);
    },
  });

  // Oferta automática: la API elige al mejor motorizado disponible y le avisa por ntfy; si no la
  // acepta a tiempo pasa al siguiente. La cola se actualiza sola cuando alguien acepta.
  const offer = useMutation({
    mutationFn: (shipmentId: string) => api<DispatchResult>(`/logistics/shipments/${shipmentId}/dispatch`, { method: 'POST' }),
    onSuccess: (r) => {
      const name = riders.data?.find((x) => x.riderId === r.riderId)?.name ?? 'un motorizado';
      toast.ok(`Oferta enviada a ${name}. Si no la acepta, pasa al siguiente.`);
      void qc.invalidateQueries({ queryKey: QUEUE_KEY });
    },
    onError: (e) => {
      if (isApiError(e, 'NO_RIDER_AVAILABLE')) toast.error('No hay motorizados disponibles cerca: asígnalo a mano.');
      else toast.error(e);
    },
  });

  const pick = (id: string) => {
    setSelectedId(id === selectedId ? null : id);
    setRiderId(null);
  };

  return (
    <div>
      <PageHeader
        title="Despacho"
        description="Asigna motorizados a los envíos pendientes o listos para retirar. La cola se actualiza en vivo y cada 30 s."
        actions={<ConnectionBadge state={connection} />}
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="min-w-0" aria-label="Cola de envíos">
          <QueryState query={queue} loading="Cargando la cola…">
            {(page) =>
              page.items.length === 0 ? (
                <EmptyState title="No hay envíos por despachar">Cuando la bodega termine un pedido aparecerá aquí.</EmptyState>
              ) : (
                <>
                  <div className="card overflow-x-auto">
                    <table className="table-base">
                      <thead>
                        <tr>
                          <th>Pedido</th>
                          <th>Estado</th>
                          <th>Destino</th>
                          <th>Franja</th>
                          <th className="num">Cobrar</th>
                          <th>Antigüedad</th>
                        </tr>
                      </thead>
                      <tbody>
                        {page.items.map((s) => {
                          const age = ageMinutes(s.createdAt, now);
                          return (
                            <tr
                              key={s.id}
                              onClick={() => pick(s.id)}
                              className={`cursor-pointer ${s.id === selectedId ? 'bg-sand/70' : ''}`}
                              aria-selected={s.id === selectedId}
                            >
                              <td>
                                <button type="button" className="font-mono text-xs underline-offset-2 hover:underline" onClick={(e) => (e.stopPropagation(), pick(s.id))}>
                                  {s.orderId.slice(0, 8)}
                                </button>
                              </td>
                              <td>
                                <StatusBadge status={s.status} map={SHIPMENT_STATUS} />
                              </td>
                              <td className="max-w-56 truncate" title={s.destinationLabel ?? ''}>
                                {s.destinationLabel ?? '—'}
                                {!s.dropoff && <span className="ml-1 text-xs text-warn">(sin coordenadas)</span>}
                              </td>
                              <td className="text-xs whitespace-nowrap">{formatSlot(s.slot)}</td>
                              <td className="num">{toNumber(s.codAmount) ? formatMoney(s.codAmount) : '—'}</td>
                              <td className={`text-xs whitespace-nowrap ${age >= 60 ? 'font-semibold text-danger' : age >= 30 ? 'text-warn' : ''}`}>{formatRelative(s.createdAt, new Date(now))}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Pagination total={page.total} limit={LIMIT} offset={offset} onChange={setOffset} />
                </>
              )
            }
          </QueryState>
        </section>

        <aside aria-label="Asignación" className="min-w-0">
          {!selected ? (
            <div className="card p-4 text-sm text-ink-soft">Elige un envío de la cola para ver los motorizados cercanos y asignarlo.</div>
          ) : (
            <div className="card p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold">Pedido {selected.orderId.slice(0, 8)}</h2>
                  <p className="truncate text-xs text-ink-soft">{selected.destinationLabel ?? 'Sin dirección'}</p>
                  <p className="text-xs text-ink-soft">
                    {formatSlot(selected.slot)}
                    {toNumber(selected.codAmount) ? ` · Cobrar ${formatMoney(selected.codAmount)}` : ''}
                  </p>
                </div>
                <button className="btn-ghost btn-sm" onClick={() => setSelectedId(null)} aria-label="Cerrar">
                  ✕
                </button>
              </div>

              <RidersMap
                riders={nearby}
                selectedId={riderId}
                onSelect={setRiderId}
                destinations={selected.dropoff ? [{ id: selected.id, ...selected.dropoff, label: 'Destino' }] : []}
                lines={selected.dropoff && riderId ? nearby.filter((r) => r.riderId === riderId && r.lastLocation).map((r) => [r.lastLocation!, selected.dropoff!]) : []}
                fitKey={selected.id}
                className="mt-3 h-64"
                label="Mapa del envío y motorizados cercanos"
              />

              <h3 className="mt-3 text-xs font-semibold tracking-wide text-ink-soft uppercase">Motorizados</h3>
              {riders.error && !riders.data ? (
                <ErrorState error={riders.error} onRetry={() => void riders.refetch()} />
              ) : ranked.length === 0 ? (
                <p className="mt-1 text-sm text-ink-soft">{riders.isPending ? 'Cargando…' : 'No hay motorizados activos.'}</p>
              ) : (
                <fieldset className="mt-1 max-h-80 space-y-1 overflow-y-auto">
                  <legend className="sr-only">Elige el motorizado</legend>
                  {ranked.map(({ rider, distanceM }) => {
                    const cod = wouldExceedCod(rider, selected.codAmount);
                    return (
                      <label
                        key={rider.riderId}
                        className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${riderId === rider.riderId ? 'border-ink bg-sand/60' : 'border-line hover:border-ink-soft'}`}
                      >
                        <input type="radio" name="rider" value={rider.riderId} checked={riderId === rider.riderId} onChange={() => setRiderId(rider.riderId)} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{rider.name ?? 'Sin nombre'}</span>
                          <span className="block text-[11px] text-ink-soft">
                            {rider.activeShipments.length} en curso · efectivo {formatMoney(rider.codBalance)}/{formatMoney(rider.codLimit)}
                          </span>
                        </span>
                        <span className="flex flex-col items-end gap-0.5">
                          <StatusBadge status={rider.presence} map={PRESENCE_LABEL} />
                          <span className="text-[11px] text-ink-soft tabular-nums">{formatDistance(distanceM)}</span>
                          {cod && <Badge tone="danger">Pasa el tope</Badge>}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              )}
              <button
                className="btn-primary mt-3 w-full"
                disabled={!riderId || assign.isPending}
                onClick={() => riderId && assign.mutate({ shipmentId: selected.id, riderId })}
              >
                {assign.isPending ? 'Asignando…' : 'Asignar envío'}
              </button>
              <button className="btn-ghost mt-2 w-full" disabled={offer.isPending} onClick={() => offer.mutate(selected.id)}>
                {offer.isPending ? 'Enviando oferta…' : 'Ofrecer al mejor disponible (app)'}
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
