'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth, useCan } from '@/components/providers/AuthProvider';
import { api } from '@/lib/api/client';
import { fullName } from '@/lib/format';
import type { Agent } from '@/lib/support';
import type { Page } from '@/lib/types';

/** Hora actual que avanza sola (los "vence en…" del SLA se mantienen al día sin recargar). */
export function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/**
 * Agentes de soporte para mostrar nombres y reasignar. El módulo Soporte no expone un listado de
 * agentes: se usa GET /iam/users?type=staff&role=support, solo si el usuario tiene iam.users.read.
 * Sin ese permiso `available` es false y la pantalla muestra ids cortos y solo permite "Tomar".
 */
export function useAgents() {
  const can = useCan();
  const { user } = useAuth();
  const allowed = can('iam.users.read');
  const q = useQuery({
    queryKey: ['soporte', 'agents'],
    queryFn: ({ signal }) => api<Page<Agent>>('/iam/users', { query: { type: 'staff', role: 'support', status: 'active', limit: 100 }, signal }),
    enabled: allowed,
    staleTime: 5 * 60_000,
  });
  const agents = q.data?.items ?? [];
  const byId = new Map(agents.map((a) => [a.id, a]));

  function name(id: string | null): string {
    if (!id) return 'Sin asignar';
    if (id === user?.id) return 'Yo';
    const a = byId.get(id);
    return a ? fullName(a.firstName, a.lastName) || a.email : `Agente ${id.slice(0, 8)}`;
  }

  return { available: allowed && q.isSuccess, agents, name, meId: user?.id ?? null };
}
