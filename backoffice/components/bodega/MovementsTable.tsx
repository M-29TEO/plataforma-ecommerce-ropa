'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useResolveVariants } from '@/components/scanner/variant-cache';
import { StatusBadge } from '@/components/ui/Badge';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/lib/api/client';
import { formatDateTime, formatMoney } from '@/lib/format';
import { MOVEMENT_TYPE, signed, type StockMovement } from '@/lib/inventory';
import { useWarehouseName, VariantName } from './shared';

const PAGE = 20;

/** Historial de movimientos (GET /inventory/stock/movements), paginado por cursor beforeId. */
export function MovementsTable({ warehouseId, variantId }: { warehouseId?: string; variantId?: string }) {
  const warehouseName = useWarehouseName();
  const q = useInfiniteQuery({
    queryKey: ['inventory', 'stock', 'movements', { warehouseId, variantId }],
    queryFn: ({ pageParam, signal }) =>
      api<StockMovement[]>('/inventory/stock/movements', {
        query: { warehouseId, variantId, beforeId: pageParam || undefined, limit: PAGE },
        signal,
      }),
    initialPageParam: '',
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last[last.length - 1].id),
    enabled: Boolean(warehouseId || variantId),
  });

  const rows = q.data?.pages.flat() ?? [];
  useResolveVariants(variantId ? [] : rows.map((m) => m.variantId));

  if (!warehouseId && !variantId) return null;
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (rows.length === 0) return <EmptyState title="Sin movimientos registrados" />;

  return (
    <div>
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Fecha</th>
              {!variantId && <th>Variante</th>}
              {!warehouseId && <th>Bodega</th>}
              <th>Tipo</th>
              <th className="num">Cantidad</th>
              <th>Motivo / referencia</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap">{formatDateTime(m.createdAt)}</td>
                {!variantId && (
                  <td className="max-w-56">
                    <VariantName variantId={m.variantId} compact />
                  </td>
                )}
                {!warehouseId && <td className="whitespace-nowrap">{warehouseName(m.warehouseId)}</td>}
                <td>
                  <StatusBadge status={m.movementType} map={MOVEMENT_TYPE} />
                </td>
                <td className={`num font-medium ${m.quantity < 0 ? 'text-danger' : m.quantity > 0 ? 'text-ok' : ''}`}>{signed(m.quantity)}</td>
                <td className="max-w-72 text-xs text-ink-soft">
                  {m.reason ?? '—'}
                  {m.unitCost && <> · costo {formatMoney(m.unitCost)}</>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && (
        <div className="mt-3 text-center">
          <button className="btn-ghost btn-sm" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage ? 'Cargando…' : 'Ver más'}
          </button>
        </div>
      )}
    </div>
  );
}
