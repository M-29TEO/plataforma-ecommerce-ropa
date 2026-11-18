'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { api } from '@/lib/api/client';
import { type LiveRider, needsRefetch, reduceRiders, type ShipmentStatusEvent, type StaffEvent } from '@/lib/logistics';
import { useStaffSocket } from '@/lib/realtime';

export const LIVE_RIDERS_KEY = ['logistics', 'riders', 'live'] as const;
/** Respaldo por HTTP cuando el socket está caído (y en despacho, siempre). */
export const POLL_MS = 30_000;

/**
 * Motorizados en vivo: carga por HTTP y aplica los eventos del socket sobre la caché de
 * TanStack Query (las pantallas del mapa y del despacho comparten la misma lista).
 */
export function useLiveRiders({ onShipmentStatus }: { onShipmentStatus?: (e: ShipmentStatusEvent) => void } = {}) {
  const qc = useQueryClient();
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusCb = useRef(onShipmentStatus);
  useEffect(() => {
    statusCb.current = onShipmentStatus;
  });

  // Un envío recién asignado llega sin destino: se pide la lista de nuevo (agrupado, 1 s).
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void qc.invalidateQueries({ queryKey: LIVE_RIDERS_KEY });
    }, 1000);
  }, [qc]);
  useEffect(() => () => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
  }, []);

  const onEvent = useCallback(
    (event: StaffEvent) => {
      const current = qc.getQueryData<LiveRider[]>(LIVE_RIDERS_KEY);
      if (current) {
        const next = reduceRiders(current, event);
        if (next !== current) qc.setQueryData(LIVE_RIDERS_KEY, next);
        if (needsRefetch(current, event)) scheduleRefetch();
      }
      if (event.type === 'status') statusCb.current?.(event.data);
    },
    [qc, scheduleRefetch],
  );
  const onResync = useCallback(() => void qc.invalidateQueries({ queryKey: ['logistics'] }), [qc]);
  const connection = useStaffSocket({ onEvent, onResync });

  const riders = useQuery({
    queryKey: LIVE_RIDERS_KEY,
    queryFn: ({ signal }) => api<LiveRider[]>('/logistics/riders/live', { signal }),
    refetchInterval: connection === 'live' ? false : POLL_MS,
  });

  return { riders, connection };
}
