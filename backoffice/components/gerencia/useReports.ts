'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import {
  previousRange,
  REPORT_PATH,
  type DateRange,
  type KpiBlock,
  type KpiResult,
  type MetricsByKind,
  type ReportKind,
  type ReportResult,
} from '@/lib/reports';

/** Las vistas se refrescan cada 15 min: no tiene sentido volver a pedir antes de 1 min. */
const STALE = 60_000;

export function useReport<K extends ReportKind>(
  kind: K,
  range: DateRange,
  opts: { groupBy?: string; limit?: number; enabled?: boolean } = {},
) {
  const { groupBy, limit, enabled = true } = opts;
  return useQuery({
    queryKey: ['reports', kind, range.from, range.to, groupBy ?? null, limit ?? null],
    queryFn: ({ signal }) =>
      api<ReportResult<MetricsByKind[K]>>(REPORT_PATH[kind], { query: { from: range.from, to: range.to, groupBy, limit }, signal }),
    enabled,
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
}

type KpiKind = 'sales' | 'funnel' | 'delivery';

/**
 * Agrupación barata para pedir solo los totales cuando no se puede usar /reports/kpis (que exige
 * los tres permisos): una dimensión que no es de tiempo con limit=1; el embudo solo admite tiempo.
 */
const TOTALS_ONLY: Record<KpiKind, { groupBy: string; limit?: number }> = {
  sales: { groupBy: 'channel', limit: 1 },
  delivery: { groupBy: 'carrier_type', limit: 1 },
  funnel: { groupBy: 'month' },
};

export interface KpiQuery<M> {
  data: KpiBlock<M> | undefined;
  dataAsOf: string | null;
  error: unknown;
  isPending: boolean;
  refetch: () => unknown;
}

/** Totales del período y del anterior para un reporte, con dos consultas al reporte. */
function useKpiFallback<K extends KpiKind>(kind: K, range: DateRange, enabled: boolean): KpiQuery<MetricsByKind[K]> {
  const opts = { ...TOTALS_ONLY[kind], enabled };
  const current = useReport(kind, range, opts);
  const previous = useReport(kind, previousRange(range), opts);
  return {
    data: current.data && previous.data ? { current: current.data.totals, previous: previous.data.totals } : undefined,
    dataAsOf: current.data?.dataAsOf ?? null,
    error: current.error ?? previous.error,
    isPending: current.isPending || previous.isPending,
    refetch: () => {
      void current.refetch();
      void previous.refetch();
    },
  };
}

/**
 * KPIs con comparación vs. el período anterior del mismo largo. Con los tres permisos usa
 * /reports/kpis (una consulta); si no, pide los totales de cada reporte permitido por separado.
 */
export function useKpis(range: DateRange, can: (perm: string) => boolean) {
  const canSales = can('reports.sales.read');
  const canFunnel = can('reports.funnel.read');
  const canDelivery = can('reports.delivery.read');
  const all = canSales && canFunnel && canDelivery;

  const kpis = useQuery({
    queryKey: ['reports', 'kpis', range.from, range.to],
    queryFn: ({ signal }) => api<KpiResult>('/reports/kpis', { query: { from: range.from, to: range.to }, signal }),
    enabled: all,
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
  const sales = useKpiFallback('sales', range, canSales && !all);
  const funnel = useKpiFallback('funnel', range, canFunnel && !all);
  const delivery = useKpiFallback('delivery', range, canDelivery && !all);

  if (all) {
    const pick = <K extends KpiKind>(k: K): KpiQuery<MetricsByKind[K]> => ({
      data: kpis.data?.[k] as KpiBlock<MetricsByKind[K]> | undefined,
      dataAsOf: kpis.data?.dataAsOf ?? null,
      error: kpis.error,
      isPending: kpis.isPending,
      refetch: () => void kpis.refetch(),
    });
    return { sales: pick('sales'), funnel: pick('funnel'), delivery: pick('delivery'), previous: kpis.data ? { from: kpis.data.previousFrom, to: kpis.data.previousTo } : previousRange(range) };
  }
  return {
    sales: canSales ? sales : null,
    funnel: canFunnel ? funnel : null,
    delivery: canDelivery ? delivery : null,
    previous: previousRange(range),
  };
}
