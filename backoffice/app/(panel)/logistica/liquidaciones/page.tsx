'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { GenerateWeekModal } from '@/components/logistica/GenerateWeekModal';
import { StatTile, useRiderNames } from '@/components/logistica/shared';
import { useCan } from '@/components/providers/AuthProvider';
import { StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, QueryState } from '@/components/ui/States';
import { api } from '@/lib/api/client';
import { formatInt, formatMoney, isoDateInStore } from '@/lib/format';
import { formatWeek, recentWeeks, type Settlement, SETTLEMENT_STATUS, type SettlementStatus, settlementTotals } from '@/lib/logistics';

const LIMIT = 50;
const STATUSES = Object.keys(SETTLEMENT_STATUS) as SettlementStatus[];

/** Liquidaciones semanales de motorizados: listado por semana y estado, con totales y generación. */
export default function SettlementsPage() {
  const can = useCan();
  const { riders, nameOf } = useRiderNames();
  const weeks = useMemo(() => recentWeeks(isoDateInStore(), 12), []);
  const [week, setWeek] = useState(weeks[0]);
  const [status, setStatus] = useState<SettlementStatus | ''>('');
  const [riderId, setRiderId] = useState('');
  const [offset, setOffset] = useState(0);
  const [generating, setGenerating] = useState(false);

  // El API devuelve un arreglo sin total: se pide uno de más para saber si hay página siguiente.
  const list = useQuery({
    queryKey: ['logistics', 'settlements', 'list', { week, status, riderId, offset }],
    queryFn: ({ signal }) =>
      api<Settlement[]>('/logistics/settlements', { query: { periodStart: week, status, riderId, limit: LIMIT + 1, offset }, signal }),
    placeholderData: (prev) => prev,
  });

  const filter = (fn: () => void) => {
    fn();
    setOffset(0);
  };

  return (
    <div>
      <PageHeader
        title="Liquidaciones de motorizados"
        description="Comisiones semanales, efectivo cobrado y neto a pagar. Aprobar y marcar pagada lo hacen personas distintas."
        actions={
          can('logistics.settlement.manage') && (
            <button className="btn-primary" onClick={() => setGenerating(true)}>
              Generar semana
            </button>
          )
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="f-week" className="label">
            Semana
          </label>
          <select id="f-week" className="input" value={week} onChange={(e) => filter(() => setWeek(e.target.value))}>
            <option value="">Todas</option>
            {weeks.map((w) => (
              <option key={w} value={w}>
                {formatWeek(w)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-status" className="label">
            Estado
          </label>
          <select id="f-status" className="input" value={status} onChange={(e) => filter(() => setStatus(e.target.value as SettlementStatus | ''))}>
            <option value="">Todos</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {SETTLEMENT_STATUS[s][0]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-rider" className="label">
            Motorizado
          </label>
          <select id="f-rider" className="input" value={riderId} onChange={(e) => filter(() => setRiderId(e.target.value))}>
            <option value="">Todos</option>
            {riders.map((r) => (
              <option key={r.riderId} value={r.riderId}>
                {r.name ?? r.riderId.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <QueryState query={list} loading="Cargando liquidaciones…">
        {(data) => {
          const rows = data.slice(0, LIMIT);
          const hasMore = data.length > LIMIT;
          const t = settlementTotals(rows);
          return rows.length === 0 ? (
            <EmptyState title="Sin liquidaciones">
              {week ? 'No hay liquidaciones para esta semana con esos filtros.' : 'No hay liquidaciones con esos filtros.'}
              {can('logistics.settlement.manage') && ' Puedes generarlas con «Generar semana».'}
            </EmptyState>
          ) : (
            <>
              <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
                <StatTile label="Liquidaciones" value={formatInt(t.count)} hint={hasMore || offset > 0 ? 'de esta página' : undefined} />
                <StatTile label="Entregas" value={formatInt(t.deliveries)} />
                <StatTile label="Comisiones + bonos" value={formatMoney(t.grossFees + t.bonuses)} />
                <StatTile label="Efectivo cobrado" value={formatMoney(t.codCollected)} hint={`Remitido ${formatMoney(t.codRemitted)}`} />
                <StatTile label="Neto a pagar" value={formatMoney(t.netPayable)} />
              </div>
              <div className="card overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Motorizado</th>
                      <th>Semana</th>
                      <th>Estado</th>
                      <th className="num">Entregas</th>
                      <th className="num">Comisiones</th>
                      <th className="num">Bonos</th>
                      <th className="num">Descuentos</th>
                      <th className="num">Efectivo cobrado</th>
                      <th className="num">Neto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <Link href={`/logistica/liquidaciones/${s.id}`} prefetch={false} className="font-medium underline-offset-2 hover:underline">
                            {nameOf(s.riderId)}
                          </Link>
                        </td>
                        <td className="text-xs whitespace-nowrap">{formatWeek(s.periodStart, s.periodEnd)}</td>
                        <td>
                          <StatusBadge status={s.status} map={SETTLEMENT_STATUS} />
                        </td>
                        <td className="num">{formatInt(s.deliveriesCount)}</td>
                        <td className="num">{formatMoney(s.grossFees)}</td>
                        <td className="num">{formatMoney(s.bonuses)}</td>
                        <td className="num">{formatMoney(s.deductions)}</td>
                        <td className="num">{formatMoney(s.codCollected)}</td>
                        <td className="num font-semibold">{formatMoney(s.netPayable)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-xs text-ink-soft">
                <span>
                  {offset + 1}–{offset + rows.length}
                </span>
                <div className="flex gap-2">
                  <button className="btn-ghost btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
                    Anterior
                  </button>
                  <button className="btn-ghost btn-sm" disabled={!hasMore} onClick={() => setOffset(offset + LIMIT)}>
                    Siguiente
                  </button>
                </div>
              </div>
            </>
          );
        }}
      </QueryState>

      <GenerateWeekModal open={generating} onClose={() => setGenerating(false)} nameOf={nameOf} />
    </div>
  );
}
