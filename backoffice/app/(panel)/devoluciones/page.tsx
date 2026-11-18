'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useId, useState } from 'react';
import { SimplePager } from '@/components/pedidos/SimplePager';
import { StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, QueryState } from '@/components/ui/States';
import { api } from '@/lib/api/client';
import { formatDateTime, formatMoney } from '@/lib/format';
import {
  RESOLUTION_LABEL,
  RETURN_STATUS,
  RETURN_STATUSES,
  RETURN_TYPE_LABEL,
  returnsQuery,
  type ReturnStatusFilter,
  type ReturnSummary,
  unitsOf,
} from '@/lib/returns';

const LIMIT = 25;

/** Cola de devoluciones y cambios (GET /returns), filtrable por estado. */
export default function ReturnsQueuePage() {
  const id = useId();
  const [status, setStatus] = useState<ReturnStatusFilter>('active');
  const [offset, setOffset] = useState(0);
  const query = returnsQuery(status, LIMIT, offset);

  const list = useQuery({
    queryKey: ['returns', 'list', query],
    queryFn: ({ signal }) => api<ReturnSummary[]>('/returns', { query, signal }),
    placeholderData: keepPreviousData,
    // Llegan solicitudes de clientes y retiros: se refresca cada minuto.
    refetchInterval: 60_000,
  });

  return (
    <div>
      <PageHeader title="Devoluciones" description="Solicitudes de devolución y cambio de talla: aprobación, recepción en bodega, inspección y reembolso." />

      <div className="card mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4" role="search">
        <div>
          <label className="label" htmlFor={`${id}-status`}>
            Estado
          </label>
          <select
            id={`${id}-status`}
            className="input"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as ReturnStatusFilter);
              setOffset(0);
            }}
          >
            <option value="active">Abiertas (sin cerrar)</option>
            {RETURN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {RETURN_STATUS[s][0]}
              </option>
            ))}
            <option value="">Todas</option>
          </select>
        </div>
      </div>

      <QueryState query={list} loading="Cargando devoluciones…">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title={offset > 0 ? 'No hay más devoluciones' : 'No hay devoluciones con este filtro'}>
              {offset > 0 ? (
                <button className="underline" onClick={() => setOffset(0)}>
                  Volver al inicio
                </button>
              ) : (
                'Prueba con otro estado.'
              )}
            </EmptyState>
          ) : (
            <>
              <div className="card overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>RMA</th>
                      <th>Tipo</th>
                      <th>Estado</th>
                      <th>Motivo</th>
                      <th className="num">Unid.</th>
                      <th className="num">Reembolso</th>
                      <th>Solicitada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap">
                          <Link href={`/devoluciones/${r.id}`} prefetch={false} className="font-medium underline-offset-2 hover:underline">
                            {r.rmaNumber}
                          </Link>
                          <Link href={`/pedidos/${r.orderId}`} prefetch={false} className="block text-xs text-ink-soft hover:underline">
                            Ver pedido
                          </Link>
                        </td>
                        <td className="whitespace-nowrap text-sm">
                          {RETURN_TYPE_LABEL[r.type] ?? r.type}
                          <span className="block text-xs text-ink-soft">{RESOLUTION_LABEL[r.resolution] ?? r.resolution}</span>
                        </td>
                        <td>
                          <StatusBadge status={r.status} map={RETURN_STATUS} />
                        </td>
                        <td className="max-w-72 truncate text-sm" title={r.reason}>
                          {r.reason}
                        </td>
                        <td className="num">{unitsOf(r)}</td>
                        <td className="num">{r.refundAmount ? formatMoney(r.refundAmount) : '—'}</td>
                        <td className="whitespace-nowrap text-xs text-ink-soft">{formatDateTime(r.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <SimplePager count={rows.length} limit={LIMIT} offset={offset} onChange={setOffset} />
            </>
          )
        }
      </QueryState>
    </div>
  );
}
