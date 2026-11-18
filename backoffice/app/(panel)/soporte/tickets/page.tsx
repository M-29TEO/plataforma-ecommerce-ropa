'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useId, useState } from 'react';
import { useAgents, useNow } from '@/components/soporte/hooks';
import { SlaBadge } from '@/components/soporte/SlaBadge';
import { useCan } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/providers/ToastProvider';
import { StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, QueryState } from '@/components/ui/States';
import { api, isApiError } from '@/lib/api/client';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import {
  CATEGORY_LABELS,
  PRIORITY_MAP,
  queueQuery,
  sortBySla,
  STATUS_MAP,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Ticket,
  type TicketFilters,
} from '@/lib/support';

const LIMIT = 25;
const INITIAL: TicketFilters = { status: 'active', priority: '', assigned: '', overdue: false, number: '' };

/** Cola de soporte ordenada por vencimiento del SLA (el API ya la devuelve así), con "Tomar". */
export default function TicketQueuePage() {
  const id = useId();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const now = useNow();
  const agents = useAgents();
  const [filters, setFilters] = useState<TicketFilters>(INITIAL);
  const [offset, setOffset] = useState(0);
  const number = useDebounced(filters.number, 350);
  const query = queueQuery({ ...filters, number }, LIMIT, offset);
  const canWrite = can('support.tickets.write');
  // Quitarle el ticket a otro agente es reasignar: se ofrece solo a quien puede asignar.
  const canAssign = can('support.tickets.assign');

  const list = useQuery({
    queryKey: ['soporte', 'tickets', query],
    queryFn: ({ signal }) => api<Ticket[]>('/support/tickets', { query, signal }),
    placeholderData: keepPreviousData,
    // La cola cambia sola (clientes que responden, tickets automáticos): se refresca cada 30 s.
    refetchInterval: 30_000,
  });

  const take = useMutation({
    mutationFn: (t: Ticket) => api<Ticket>(`/support/tickets/${t.id}/take`, { method: 'POST', body: { expectedVersion: t.version } }),
    onSuccess: (t) => toast.ok(`Tomaste el ticket #${t.number}`),
    onError: (e) => {
      if (isApiError(e, 'STALE_VERSION')) toast.info('Otro agente cambió ese ticket: la cola se actualizó, revísalo de nuevo');
      else toast.error(e);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['soporte', 'tickets'] }),
  });

  function set<K extends keyof TicketFilters>(key: K, value: TicketFilters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
    setOffset(0);
  }

  return (
    <div>
      <PageHeader title="Tickets de soporte" description="Ordenados por vencimiento del SLA: primero los que vencen antes." />

      <div className="card mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5" role="search">
        <div>
          <label className="label" htmlFor={`${id}-number`}>
            Buscar por número
          </label>
          <input
            id={`${id}-number`}
            className="input"
            inputMode="numeric"
            placeholder="Ej. 1024"
            value={filters.number}
            onChange={(e) => set('number', e.target.value.replace(/[^\d#]/g, ''))}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-status`}>
            Estado
          </label>
          <select id={`${id}-status`} className="input" value={filters.status} onChange={(e) => set('status', e.target.value as TicketFilters['status'])}>
            <option value="active">Activos (sin resolver)</option>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_MAP[s][0]}
              </option>
            ))}
            <option value="">Todos</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`${id}-priority`}>
            Prioridad
          </label>
          <select id={`${id}-priority`} className="input" value={filters.priority} onChange={(e) => set('priority', e.target.value as TicketFilters['priority'])}>
            <option value="">Todas</option>
            {[...TICKET_PRIORITIES].reverse().map((p) => (
              <option key={p} value={p}>
                {PRIORITY_MAP[p][0]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`${id}-assigned`}>
            Asignación
          </label>
          <select id={`${id}-assigned`} className="input" value={filters.assigned} onChange={(e) => set('assigned', e.target.value as TicketFilters['assigned'])}>
            <option value="">Todos</option>
            <option value="me">Asignados a mí</option>
            <option value="none">Sin asignar</option>
          </select>
        </div>
        <div className="flex items-end">
          <label className="inline-flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={filters.overdue} onChange={(e) => set('overdue', e.target.checked)} />
            Solo SLA vencido
          </label>
        </div>
      </div>

      <QueryState query={list} loading="Cargando la cola…">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title={offset > 0 ? 'No hay más tickets' : 'No hay tickets con estos filtros'}>
              {offset > 0 ? (
                <button className="underline" onClick={() => setOffset(0)}>
                  Volver al inicio
                </button>
              ) : (
                'Prueba con otros filtros.'
              )}
            </EmptyState>
          ) : (
            <>
              <div className="card overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Asunto</th>
                      <th>Prioridad</th>
                      <th>Estado</th>
                      <th>SLA</th>
                      <th>Asignado</th>
                      <th>Creado</th>
                      <th className="sr-only">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortBySla(rows).map((t) => {
                      const mine = t.assignedTo === agents.meId;
                      return (
                        <tr key={t.id}>
                          <td className="whitespace-nowrap tabular-nums">
                            <Link href={`/soporte/tickets/${t.id}`} prefetch={false} className="font-medium underline-offset-2 hover:underline">
                              #{t.number}
                            </Link>
                          </td>
                          <td className="min-w-56">
                            <Link href={`/soporte/tickets/${t.id}`} prefetch={false} className="font-medium hover:underline">
                              {t.subject}
                            </Link>
                            <p className="text-xs text-ink-soft">
                              {CATEGORY_LABELS[t.category] ?? t.category}
                              {t.orderId && ' · con pedido'}
                            </p>
                          </td>
                          <td>
                            <StatusBadge status={t.priority} map={PRIORITY_MAP} />
                          </td>
                          <td>
                            <StatusBadge status={t.status} map={STATUS_MAP} />
                          </td>
                          <td className="whitespace-nowrap">
                            <SlaBadge ticket={t} now={now} />
                          </td>
                          <td className="whitespace-nowrap text-sm">{t.assignedTo ? agents.name(t.assignedTo) : <span className="text-ink-soft">Sin asignar</span>}</td>
                          <td className="whitespace-nowrap text-xs text-ink-soft" title={formatDateTime(t.createdAt)}>
                            {formatRelative(t.createdAt, now)}
                          </td>
                          <td className="text-right">
                            {canWrite && !mine && t.status !== 'closed' && (!t.assignedTo || canAssign) && (
                              <button
                                className="btn-ghost btn-sm"
                                disabled={take.isPending && take.variables?.id === t.id}
                                onClick={() => take.mutate(t)}
                                title={t.assignedTo ? 'Reasignártelo (lo tiene otro agente)' : 'Asignártelo a ti'}
                              >
                                Tomar
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-xs text-ink-soft">
                <span>
                  {offset + 1}–{offset + rows.length}
                  {list.isFetching && ' · actualizando…'}
                </span>
                <div className="flex gap-2">
                  <button className="btn-ghost btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
                    Anterior
                  </button>
                  <button className="btn-ghost btn-sm" disabled={rows.length < LIMIT} onClick={() => setOffset(offset + LIMIT)}>
                    Siguiente
                  </button>
                </div>
              </div>
            </>
          )
        }
      </QueryState>
    </div>
  );
}
