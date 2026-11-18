'use client';

import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatInt, formatMoney, formatPercent, toNumber } from '@/lib/format';
import { CHART, isOpenPeriod, pctToRatio, periodLabel, timeGroupFor, type DateRange, type SalesMetrics, type TimeGroup } from '@/lib/reports';
import { Block, BlockState, ChartTooltip, Segmented, TableToggle } from './Block';
import { useReport } from './useReports';

type Metric = 'netSales' | 'orders';

const compactMoney = new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const compactInt = new Intl.NumberFormat('es-EC', { notation: 'compact', maximumFractionDigits: 1 });

const GROUPS: { value: TimeGroup; label: string }[] = [
  { value: 'day', label: 'Día' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
];

/** Ventas en el tiempo: una sola serie (acento), línea de 2 px con relleno suave, tooltip con cruz. */
export function SalesTrend({ range }: { range: DateRange }) {
  const [metric, setMetric] = useState<Metric>('netSales');
  const [group, setGroup] = useState<TimeGroup | null>(null);
  const [table, setTable] = useState(false);
  const groupBy = group ?? timeGroupFor(range);
  const q = useReport('sales', range, { groupBy });

  return (
    <Block
      title="Ventas en el tiempo"
      subtitle={metric === 'netSales' ? 'Ventas netas (sin IVA, menos devoluciones)' : 'Pedidos vendidos'}
      dataAsOf={q.data?.dataAsOf}
      className="lg:col-span-2"
      controls={
        <>
          <Segmented label="Métrica" value={metric} onChange={setMetric} options={[{ value: 'netSales', label: 'Ventas' }, { value: 'orders', label: 'Pedidos' }]} />
          <Segmented label="Agrupar por" value={groupBy as TimeGroup} onChange={setGroup} options={GROUPS} />
          <TableToggle table={table} onChange={setTable} />
        </>
      }
    >
      <BlockState query={q}>
        {(data) => {
          const base = data.rows.map((r) => ({
            ...r,
            open: isOpenPeriod(r.key, data.groupBy),
            label: periodLabel(r.key, data.groupBy),
            value: metric === 'netSales' ? (toNumber(r.netSales) ?? 0) : r.orders,
          }));
          // El período en curso (siempre el último) va en una serie punteada que arranca en el anterior.
          const openIdx = base.findIndex((r) => r.open);
          const rows = base.map((r, i) => ({
            ...r,
            solid: r.open ? null : r.value,
            partial: openIdx >= 0 && (i === openIdx || i === openIdx - 1) ? r.value : null,
          }));
          if (table) return <SalesTable rows={rows} />;
          return (
            <>
              <div className="h-64" role="img" aria-label={`Gráfico de ${metric === 'netSales' ? 'ventas netas' : 'pedidos'} por ${groupBy === 'day' ? 'día' : groupBy === 'week' ? 'semana' : 'mes'}`}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke={CHART.grid} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: CHART.axis }} tickLine={false} axisLine={{ stroke: CHART.grid }} minTickGap={16} />
                    <YAxis
                      width={56}
                      tick={{ fontSize: 11, fill: CHART.axis }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={metric === 'netSales'}
                      tickFormatter={(v: number) => (metric === 'netSales' ? compactMoney.format(v) : compactInt.format(v))}
                    />
                    <Tooltip
                      cursor={{ stroke: CHART.axis, strokeWidth: 1 }}
                      content={({ active, payload }) => {
                        const row = active && payload?.[0] ? (payload[0].payload as (typeof rows)[number]) : null;
                        if (!row) return null;
                        return (
                          <ChartTooltip
                            title={row.open ? `${row.label} (en curso)` : row.label}
                            rows={[
                              { label: 'Ventas netas', value: formatMoney(row.netSales), color: metric === 'netSales' ? CHART.series1 : undefined },
                              { label: 'Pedidos', value: formatInt(row.orders), color: metric === 'orders' ? CHART.series1 : undefined },
                              { label: 'Ticket promedio', value: formatMoney(row.averageTicket) },
                              { label: 'Margen', value: formatPercent(pctToRatio(row.marginPct)) },
                            ]}
                          />
                        );
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="solid"
                      stroke={CHART.series1}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      fill={CHART.series1}
                      fillOpacity={0.1}
                      dot={false}
                      activeDot={{ r: 4, fill: CHART.series1, stroke: CHART.surface, strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                    {openIdx >= 0 && (
                      <Area
                        type="monotone"
                        dataKey="partial"
                        stroke={CHART.series1}
                        strokeWidth={2}
                        strokeDasharray="4 4"
                        fill={CHART.series1}
                        fillOpacity={0.04}
                        dot={false}
                        activeDot={{ r: 4, fill: CHART.surface, stroke: CHART.series1, strokeWidth: 2 }}
                        isAnimationActive={false}
                      />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              {openIdx >= 0 && <p className="mt-2 text-xs text-ink-soft">Línea punteada: {groupBy === 'day' ? 'hoy' : groupBy === 'week' ? 'esta semana' : 'este mes'} sigue en curso, sus ventas aún no están completas.</p>}
            </>
          );
        }}
      </BlockState>
    </Block>
  );
}

function SalesTable({ rows }: { rows: (SalesMetrics & { key: string; label: string })[] }) {
  return (
    <div className="max-h-64 overflow-auto">
      <table className="table-base">
        <thead>
          <tr>
            <th>Período</th>
            <th className="num">Pedidos</th>
            <th className="num">Ventas netas</th>
            <th className="num">Ventas brutas</th>
            <th className="num">Ticket prom.</th>
            <th className="num">Margen %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td className="num">{formatInt(r.orders)}</td>
              <td className="num">{formatMoney(r.netSales)}</td>
              <td className="num">{formatMoney(r.grossSales)}</td>
              <td className="num">{formatMoney(r.averageTicket)}</td>
              <td className="num">{formatPercent(pctToRatio(r.marginPct))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
