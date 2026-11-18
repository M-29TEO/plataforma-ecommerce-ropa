'use client';

import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatInt, formatMoney, formatPercent } from '@/lib/format';
import { CHART, funnelStages, pctToRatio, type DateRange } from '@/lib/reports';
import { Block, BlockState, ChartTooltip } from './Block';
import { useReport } from './useReports';

/**
 * Embudo carrito → compra: etapas ordinales en un solo tono (claro a oscuro), cada una con la tasa
 * de paso desde la anterior. No hay tracking de visitas: la conversión es carrito → compra.
 */
export function FunnelBlock({ range }: { range: DateRange }) {
  // groupBy=month: solo se usan los totales (misma consulta que los KPIs sin /reports/kpis).
  const q = useReport('funnel', range, { groupBy: 'month' });

  return (
    <Block title="Embudo de conversión" subtitle="Del carrito a la venta pagada" dataAsOf={q.data?.dataAsOf}>
      <BlockState query={q} height={220}>
        {(data) => {
          const t = data.totals;
          const stages = funnelStages(t).map((s, i) => ({ ...s, color: CHART.ordinal[i] }));
          return (
            <>
              <div className="h-44" role="img" aria-label="Embudo: carritos creados, con productos, pedidos creados y ventas">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stages} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }} barCategoryGap={6}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="label" width={112} tick={{ fontSize: 11, fill: CHART.ink }} tickLine={false} axisLine={{ stroke: CHART.grid }} />
                    <Tooltip
                      cursor={{ fill: CHART.grid, fillOpacity: 0.4 }}
                      content={({ active, payload }) => {
                        const s = active && payload?.[0] ? (payload[0].payload as (typeof stages)[number]) : null;
                        if (!s) return null;
                        return (
                          <ChartTooltip
                            title={s.label}
                            rows={[
                              { label: 'Cantidad', value: formatInt(s.value), color: s.color },
                              ...(s.stepRate !== null ? [{ label: 'Paso desde la etapa anterior', value: formatPercent(s.stepRate) }] : []),
                            ]}
                          />
                        );
                      }}
                    />
                    <Bar dataKey="value" barSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                      {stages.map((s) => (
                        <Cell key={s.key} fill={s.color} />
                      ))}
                      <LabelList dataKey="value" position="right" fill={CHART.ink} fontSize={11} formatter={(v: unknown) => formatInt(Number(v))} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <Fact label="Conversión" value={formatPercent(pctToRatio(t.conversionRate))} />
                <Fact label="Abandono" value={formatPercent(pctToRatio(t.abandonmentRate))} />
                <Fact label="Valor abandonado" value={formatMoney(t.abandonedValue)} />
                <Fact label="Recordatorios enviados" value={formatInt(t.cartsReminded)} />
                <Fact label="Carritos abandonados" value={formatInt(t.cartsAbandoned)} />
                <Fact label="Ingresos" value={formatMoney(t.revenue)} />
              </dl>
            </>
          );
        }}
      </BlockState>
    </Block>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/70 pb-1">
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
