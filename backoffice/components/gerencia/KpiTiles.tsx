'use client';

import { Badge } from '@/components/ui/Badge';
import { ErrorState } from '@/components/ui/States';
import { formatDate, formatInt, formatMoney, formatPercent } from '@/lib/format';
import {
  delta,
  deltaTone,
  formatDelta,
  formatMinutes,
  pctToRatio,
  type DateRange,
  type DeliveryMetrics,
  type FunnelMetrics,
  type KpiBlock,
  type SalesMetrics,
} from '@/lib/reports';
import type { KpiQuery } from './useReports';

interface TileDef<M> {
  label: string;
  value: (m: M) => string;
  raw: (m: M) => string | number | null;
  /** Tasas (ya en %): la variación va en puntos. */
  points?: boolean;
  /** false si bajar es lo bueno (abandono, tiempo de entrega). */
  upIsGood?: boolean;
  hint?: string;
}

const SALES: TileDef<SalesMetrics>[] = [
  { label: 'Ventas netas', value: (m) => formatMoney(m.netSales), raw: (m) => m.netSales, hint: 'Mercadería sin IVA, menos devoluciones' },
  { label: 'Pedidos', value: (m) => formatInt(m.orders), raw: (m) => m.orders },
  { label: 'Ticket promedio', value: (m) => formatMoney(m.averageTicket), raw: (m) => m.averageTicket, hint: 'Ventas brutas / pedidos' },
  { label: 'Margen', value: (m) => formatPercent(pctToRatio(m.marginPct)), raw: (m) => m.marginPct, points: true, hint: 'Sobre las líneas con costo' },
];

const FUNNEL: TileDef<FunnelMetrics>[] = [
  { label: 'Conversión', value: (m) => formatPercent(pctToRatio(m.conversionRate)), raw: (m) => m.conversionRate, points: true, hint: 'Ventas / carritos con productos' },
  { label: 'Carritos abandonados', value: (m) => formatPercent(pctToRatio(m.abandonmentRate)), raw: (m) => m.abandonmentRate, points: true, upIsGood: false },
];

const DELIVERY: TileDef<DeliveryMetrics>[] = [
  { label: 'Entregas a tiempo', value: (m) => formatPercent(pctToRatio(m.onTimeRate)), raw: (m) => m.onTimeRate, points: true },
  { label: 'Pago a entrega', value: (m) => formatMinutes(m.avgLeadMinutes), raw: (m) => m.avgLeadMinutes, upIsGood: false, hint: 'Tiempo promedio' },
];

/**
 * Stat tile: etiqueta, valor y variación vs. el período anterior (flecha + texto, nunca solo color;
 * verde/rojo según si la dirección es buena para esa métrica).
 */
function Tile<M>({ def, block }: { def: TileDef<M>; block: KpiBlock<M> }) {
  const d = delta(def.raw(block.current), def.raw(block.previous), def.points ? 'points' : 'relative');
  const tone = deltaTone(d, def.upIsGood ?? true);
  const arrow = !d || d.value === 0 ? '' : d.value > 0 ? '▲ ' : '▼ ';
  return (
    <div className="card p-3" title={def.hint}>
      <p className="text-xs text-ink-soft">{def.label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{def.value(block.current)}</p>
      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-soft">
        <Badge tone={tone}>
          {arrow}
          {formatDelta(d)}
        </Badge>
        <span>antes {def.value(block.previous)}</span>
      </p>
    </div>
  );
}

function TileGroup<M>({ defs, query }: { defs: TileDef<M>[]; query: KpiQuery<M> | null }) {
  if (!query) return null;
  if (query.isPending) {
    return (
      <>
        {defs.map((d) => (
          <div key={d.label} className="card h-[92px] animate-pulse p-3">
            <p className="text-xs text-ink-soft">{d.label}</p>
          </div>
        ))}
      </>
    );
  }
  if (query.error || !query.data) {
    return (
      <div className="col-span-full">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  const block = query.data;
  return (
    <>
      {defs.map((d) => (
        <Tile key={d.label} def={d} block={block} />
      ))}
    </>
  );
}

/** Fila de KPIs: cada grupo solo si el usuario puede leer ese reporte. */
export function KpiTiles({
  sales,
  funnel,
  delivery,
  previous,
}: {
  sales: KpiQuery<SalesMetrics> | null;
  funnel: KpiQuery<FunnelMetrics> | null;
  delivery: KpiQuery<DeliveryMetrics> | null;
  previous: DateRange;
}) {
  return (
    <section aria-label="Indicadores clave">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <TileGroup defs={SALES} query={sales} />
        <TileGroup defs={FUNNEL} query={funnel} />
        <TileGroup defs={DELIVERY} query={delivery} />
      </div>
      <p className="mt-2 text-[11px] text-ink-soft">
        Comparado con el período anterior del mismo largo: {formatDate(`${previous.from}T12:00:00Z`)} al {formatDate(`${previous.to}T12:00:00Z`)}. Las tasas varían en puntos porcentuales (pp).
      </p>
    </section>
  );
}
