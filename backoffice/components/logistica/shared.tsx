'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api/client';
import type { LiveRider } from '@/lib/logistics';
import { LIVE_RIDERS_KEY } from './useLiveRiders';

/** Nombres de los motorizados (las liquidaciones solo traen riderId): se cruzan con riders/live. */
export function useRiderNames() {
  const q = useQuery({
    queryKey: LIVE_RIDERS_KEY,
    queryFn: ({ signal }) => api<LiveRider[]>('/logistics/riders/live', { signal }),
    staleTime: 60_000,
  });
  const byId = useMemo(() => new Map((q.data ?? []).map((r) => [r.riderId, r])), [q.data]);
  const nameOf = (riderId: string) => byId.get(riderId)?.name ?? `Motorizado ${riderId.slice(0, 8)}`;
  return { riders: q.data ?? [], byId, nameOf };
}

/** Cifra destacada: etiqueta pequeña y valor en tinta (sin color: el color queda para los estados). */
export function StatTile({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="card px-3 py-2.5">
      <p className="text-xs text-ink-soft">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-ink-soft">{hint}</p>}
    </div>
  );
}
