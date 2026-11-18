'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/States';
import { formatInt, formatPercent } from '@/lib/format';
import { CHART, deliveryBuckets, formatMinutes, pctToRatio, type DateRange, type DeliveryMetrics } from '@/lib/reports';
import { Block, BlockState, Segmented } from './Block';
import { useReport } from './useReports';

type DeliveryGroup = 'courier' | 'carrier_type' | 'zone' | 'rider';

const GROUPS: { value: DeliveryGroup; label: string }[] = [
  { value: 'courier', label: 'Courier' },
  { value: 'carrier_type', label: 'Tipo' },
  { value: 'zone', label: 'Zona' },
  { value: 'rider', label: 'Motorizado' },
];

/**
 * Desempeño de entregas: distribución de tiempos pago → entrega (barra 100 % con tramos ordinales,
 * separados por 2 px de superficie) y tabla por courier / tipo / zona / motorizado.
 */
export function DeliveryBlock({ range }: { range: DateRange }) {
  const [group, setGroup] = useState<DeliveryGroup>('courier');
  const q = useReport('delivery', range, { groupBy: group, limit: 20 });

  return (
    <Block
      title="Desempeño de entregas"
      subtitle="Del pago a la entrega; a tiempo = antes del fin de la franja, del ETA o del SLA del courier"
      dataAsOf={q.data?.dataAsOf}
      className="lg:col-span-2"
      controls={<Segmented label="Agrupar por" value={group} onChange={setGroup} options={GROUPS} />}
    >
      <BlockState query={q} height={220}>
        {(data) => (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <Fact label="Envíos" value={formatInt(data.totals.shipments)} />
                <Fact label="Entregados" value={`${formatInt(data.totals.delivered)} (${formatPercent(pctToRatio(data.totals.deliveryRate))})`} />
                <Fact label="Fallidos" value={formatInt(data.totals.failed)} />
                <Fact label="A tiempo" value={formatPercent(pctToRatio(data.totals.onTimeRate))} />
                <Fact label="Pago a entrega" value={formatMinutes(data.totals.avgLeadMinutes)} />
                <Fact label="En ruta" value={formatMinutes(data.totals.avgTransitMinutes)} />
                <Fact label="Calificación" value={data.totals.ratingAvg === null ? '—' : `${data.totals.ratingAvg.toFixed(1).replace('.', ',')} / 5`} />
              </dl>
              <Distribution totals={data.totals} />
            </div>
            {data.rows.length === 0 ? <EmptyState title="Sin envíos en el rango" /> : <DeliveryTable rows={data.rows} group={GROUPS.find((g) => g.value === group)!.label} />}
          </div>
        )}
      </BlockState>
    </Block>
  );
}

function Distribution({ totals }: { totals: DeliveryMetrics }) {
  const buckets = deliveryBuckets(totals);
  const any = buckets.some((b) => b.value > 0);
  return (
    <figure className="mt-4">
      <figcaption className="mb-1.5 text-xs text-ink-soft">Tiempo de entrega (entregados)</figcaption>
      {any ? (
        <div className="flex h-4 w-full gap-[2px] overflow-hidden rounded" role="img" aria-label={buckets.map((b) => `${b.label}: ${formatInt(b.value)}`).join(', ')}>
          {buckets
            .filter((b) => b.value > 0)
            .map((b) => {
              const i = buckets.indexOf(b);
              return (
                <div
                  key={b.key}
                  className="h-full transition-opacity hover:opacity-80"
                  style={{ width: `${b.share * 100}%`, background: CHART.ordinal[i] }}
                  title={`${b.label}: ${formatInt(b.value)} (${formatPercent(b.share)})`}
                />
              );
            })}
        </div>
      ) : (
        <div className="h-4 w-full rounded bg-sand" />
      )}
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-soft">
        {buckets.map((b, i) => (
          <li key={b.key} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CHART.ordinal[i] }} aria-hidden />
            {b.label} <span className="font-medium text-ink tabular-nums">{formatPercent(b.share)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function DeliveryTable({ rows, group }: { rows: (DeliveryMetrics & { key: string; label: string })[]; group: string }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="table-base">
        <thead>
          <tr>
            <th>{group}</th>
            <th className="num">Envíos</th>
            <th className="num">Entrega %</th>
            <th className="num">A tiempo</th>
            <th className="num">Pago a entrega</th>
            <th className="num">Calif.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td className="num">{formatInt(r.shipments)}</td>
              <td className="num">{formatPercent(pctToRatio(r.deliveryRate))}</td>
              <td className="num">{formatPercent(pctToRatio(r.onTimeRate))}</td>
              <td className="num">{formatMinutes(r.avgLeadMinutes)}</td>
              <td className="num">{r.ratingAvg === null ? '—' : r.ratingAvg.toFixed(1).replace('.', ',')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
