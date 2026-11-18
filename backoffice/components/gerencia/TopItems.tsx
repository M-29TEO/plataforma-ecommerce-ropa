'use client';

import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { EmptyState } from '@/components/ui/States';
import { formatInt, formatMoney, formatPercent, toNumber } from '@/lib/format';
import { CHART, pctToRatio, type DateRange, type SalesItemsMetrics } from '@/lib/reports';
import { Block, BlockState, ChartTooltip, Segmented, TableToggle } from './Block';
import { useReport } from './useReports';

type ItemsGroup = 'product' | 'category' | 'size' | 'color';

const GROUPS: { value: ItemsGroup; label: string }[] = [
  { value: 'product', label: 'Producto' },
  { value: 'category', label: 'Categoría' },
  { value: 'size', label: 'Talla' },
  { value: 'color', label: 'Color' },
];

const LIMIT = 10;
const compactMoney = new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

function truncate(text: string, max = 22): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Top 10 por ventas netas (el API ya ordena por la métrica principal): barras horizontales con valor en la punta. */
export function TopItems({ range }: { range: DateRange }) {
  const [group, setGroup] = useState<ItemsGroup>('product');
  const [table, setTable] = useState(false);
  const q = useReport('sales_items', range, { groupBy: group, limit: LIMIT });

  return (
    <Block
      title="Lo más vendido"
      subtitle={`Top ${LIMIT} por ventas netas`}
      dataAsOf={q.data?.dataAsOf}
      controls={
        <>
          <Segmented label="Agrupar por" value={group} onChange={setGroup} options={GROUPS} />
          <TableToggle table={table} onChange={setTable} />
        </>
      }
    >
      <BlockState query={q} height={300}>
        {(data) => {
          if (data.rows.length === 0) return <EmptyState title="Sin ventas en el rango" />;
          const rows = data.rows.map((r) => ({ ...r, value: toNumber(r.netSales) ?? 0 }));
          if (table) return <ItemsTable rows={rows} />;
          return (
            <div style={{ height: Math.max(160, rows.length * 30 + 24) }} role="img" aria-label="Gráfico de barras de ventas netas por artículo">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 64, bottom: 0, left: 0 }} barCategoryGap={6}>
                  <CartesianGrid horizontal={false} stroke={CHART.grid} />
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={140}
                    tick={{ fontSize: 11, fill: CHART.ink }}
                    tickLine={false}
                    axisLine={{ stroke: CHART.grid }}
                    tickFormatter={(v: string) => truncate(v)}
                  />
                  <Tooltip
                    cursor={{ fill: CHART.grid, fillOpacity: 0.4 }}
                    content={({ active, payload }) => {
                      const row = active && payload?.[0] ? (payload[0].payload as (typeof rows)[number]) : null;
                      if (!row) return null;
                      return (
                        <ChartTooltip
                          title={row.label}
                          rows={[
                            { label: 'Ventas netas', value: formatMoney(row.netSales), color: CHART.series1 },
                            { label: 'Unidades', value: formatInt(row.units) },
                            { label: 'Devueltas', value: formatInt(row.unitsReturned) },
                            { label: 'Margen', value: formatPercent(pctToRatio(row.marginPct)) },
                          ]}
                        />
                      );
                    }}
                  />
                  <Bar dataKey="value" fill={CHART.series1} barSize={16} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                    <LabelList dataKey="value" position="right" fill={CHART.ink} fontSize={11} formatter={(v: unknown) => compactMoney.format(Number(v))} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          );
        }}
      </BlockState>
    </Block>
  );
}

function ItemsTable({ rows }: { rows: (SalesItemsMetrics & { key: string; label: string })[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table-base">
        <thead>
          <tr>
            <th>Artículo</th>
            <th className="num">Unid.</th>
            <th className="num">Devueltas</th>
            <th className="num">Ventas netas</th>
            <th className="num">Margen</th>
            <th className="num">Margen %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td className="num">{formatInt(r.units)}</td>
              <td className="num">{formatInt(r.unitsReturned)}</td>
              <td className="num">{formatMoney(r.netSales)}</td>
              <td className="num">{formatMoney(r.margin)}</td>
              <td className="num">{formatPercent(pctToRatio(r.marginPct))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
