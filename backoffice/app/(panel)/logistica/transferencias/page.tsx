'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { StatementImport } from '@/components/logistica/StatementImport';
import { VoucherModal } from '@/components/logistica/VoucherModal';
import { SimplePager } from '@/components/pedidos/SimplePager';
import { useCan } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/providers/ToastProvider';
import { Badge, type Tone } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, QueryState } from '@/components/ui/States';
import { api, errorMessage } from '@/lib/api/client';
import { formatDateTime, formatInt, formatMoney, isoDateInStore } from '@/lib/format';
import {
  HISTORY_STATUSES,
  type MatchKind,
  type MatchResult,
  matchTransfers,
  parseAmountCents,
  PENDING_STATUSES,
  type StatementLine,
  sumCents,
  type TransferPayment,
} from '@/lib/reconciliation';

const PAGE = 100;
/** Tope de pagos pendientes que se cargan para conciliar (5 páginas del API). */
const MAX_PENDING = 500;
const HISTORY_LIMIT = 20;

const MATCH_LABEL: Record<MatchKind, [string, Tone]> = {
  exact: ['Exacto', 'ok'],
  probable: ['Probable', 'warn'],
  none: ['Sin coincidencia', 'neutral'],
};

async function fetchAllPending(signal: AbortSignal): Promise<TransferPayment[]> {
  const all: TransferPayment[] = [];
  for (let offset = 0; offset < MAX_PENDING; offset += PAGE) {
    const page = await api<TransferPayment[]>('/payments', { query: { method: 'transfer', status: [...PENDING_STATUSES], limit: PAGE, offset }, signal });
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

/**
 * Conciliación de transferencias: cola de comprobantes por revisar, visor, aprobar o rechazar y
 * emparejamiento automático contra el extracto del banco importado en el navegador.
 */
export default function TransfersPage() {
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  return (
    <div>
      <PageHeader title="Conciliación de transferencias" description="Verifica los comprobantes de transferencia contra el extracto bancario." />
      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
        {(
          [
            ['pending', 'Por revisar'],
            ['history', 'Historial'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? 'border-ink font-semibold' : 'border-transparent text-ink-soft hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'pending' ? <PendingTab /> : <HistoryTab />}
    </div>
  );
}

function PendingTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const canVerify = useCan()('payments.transfer.verify');
  const [lines, setLines] = useState<StatementLine[] | null>(null);
  const [kindFilter, setKindFilter] = useState<MatchKind | ''>('');
  const [reviewing, setReviewing] = useState<TransferPayment | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number; failed: { payment: TransferPayment; message: string }[] } | null>(null);

  const pending = useQuery({
    queryKey: ['payments', 'transfers', 'pending'],
    queryFn: ({ signal }) => fetchAllPending(signal),
    refetchInterval: 60_000,
  });

  const onLines = useCallback((l: StatementLine[] | null) => setLines(l), []);
  const payments = useMemo(() => pending.data ?? [], [pending.data]);

  const matching = useMemo(() => {
    if (!lines) return null;
    const toMatch = payments.map((p) => ({
      id: p.id,
      amountCents: parseAmountCents(p.amount) ?? -1,
      expectedReference: p.transfer?.expectedReference ?? '',
      customerReference: p.transfer?.reference ?? null,
      orderNumber: p.transfer?.orderNumber ?? null,
      date: isoDateInStore(new Date(p.transfer?.voucherSubmittedAt ?? p.createdAt)),
    }));
    const r = matchTransfers(toMatch, lines);
    return { byPayment: new Map(r.results.map((m) => [m.paymentId, m])), unmatchedLines: r.unmatchedLines, results: r.results };
  }, [payments, lines]);

  const exact = useMemo(() => (matching ? payments.filter((p) => matching.byPayment.get(p.id)?.kind === 'exact') : []), [matching, payments]);
  const exactTotal = sumCents(exact.map((p) => parseAmountCents(p.amount) ?? 0)) / 100;
  const counts = useMemo(() => {
    const c: Record<MatchKind, number> = { exact: 0, probable: 0, none: 0 };
    for (const m of matching?.results ?? []) c[m.kind]++;
    return c;
  }, [matching]);
  const visible = kindFilter && matching ? payments.filter((p) => matching.byPayment.get(p.id)?.kind === kindFilter) : payments;

  const approveAllExact = async () => {
    const list = exact;
    const failed: { payment: TransferPayment; message: string }[] = [];
    setBulk({ done: 0, total: list.length, failed });
    // De a uno: cada aprobación captura el pago y emite eventos; no se satura el API.
    for (let i = 0; i < list.length; i++) {
      try {
        await api(`/payments/${list[i].id}/transfer/approve`, { method: 'POST' });
      } catch (e) {
        failed.push({ payment: list[i], message: errorMessage(e) });
      }
      setBulk({ done: i + 1, total: list.length, failed: [...failed] });
    }
    setBulkOpen(false);
    const ok = list.length - failed.length;
    if (ok > 0) toast.ok(`${ok} transferencia(s) aprobada(s).`);
    if (failed.length > 0) toast.error(`${failed.length} no se pudieron aprobar: revisa la lista.`);
    else setBulk(null);
    void qc.invalidateQueries({ queryKey: ['payments', 'transfers'] });
  };

  return (
    <div className="space-y-4">
      <StatementImport onLines={onLines} />

      {matching && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por coincidencia">
            <Chip active={kindFilter === ''} onClick={() => setKindFilter('')}>
              Todos ({payments.length})
            </Chip>
            {(['exact', 'probable', 'none'] as const).map((k) => (
              <Chip key={k} active={kindFilter === k} onClick={() => setKindFilter(kindFilter === k ? '' : k)}>
                {MATCH_LABEL[k][0]} ({counts[k]})
              </Chip>
            ))}
          </div>
          {canVerify && (
            <button className="btn-primary" disabled={exact.length === 0} onClick={() => (setBulk(null), setBulkOpen(true))}>
              Aprobar todos los exactos ({exact.length})
            </button>
          )}
        </div>
      )}

      {bulk && bulk.failed.length > 0 && !bulkOpen && (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm" role="alert">
          <p className="font-medium text-danger">No se pudieron aprobar {bulk.failed.length}:</p>
          <ul className="mt-1 list-disc pl-5">
            {bulk.failed.map((f) => (
              <li key={f.payment.id}>
                {f.payment.transfer?.orderNumber ?? f.payment.orderId.slice(0, 8)}: {f.message}
              </li>
            ))}
          </ul>
          <button className="btn-ghost btn-sm mt-2" onClick={() => setBulk(null)}>
            Entendido
          </button>
        </div>
      )}

      <QueryState query={pending} loading="Cargando transferencias…">
        {() =>
          payments.length === 0 ? (
            <EmptyState title="No hay transferencias por revisar">Cuando un cliente suba su comprobante aparecerá aquí.</EmptyState>
          ) : (
            <div className="card overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Pedido</th>
                    <th className="num">Monto</th>
                    <th>Ref. esperada</th>
                    <th>Banco</th>
                    <th>Ref. cliente</th>
                    <th>Subido</th>
                    {matching && <th>Extracto</th>}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((p) => (
                    <tr key={p.id}>
                      <td className="font-medium whitespace-nowrap">{p.transfer?.orderNumber ?? p.orderId.slice(0, 8)}</td>
                      <td className="num">{formatMoney(p.amount)}</td>
                      <td className="font-mono text-xs">{p.transfer?.expectedReference ?? '—'}</td>
                      <td>{p.transfer?.bankName ?? '—'}</td>
                      <td className="max-w-40 truncate font-mono text-xs" title={p.transfer?.reference ?? ''}>
                        {p.transfer?.reference ?? '—'}
                      </td>
                      <td className="text-xs whitespace-nowrap">{formatDateTime(p.transfer?.voucherSubmittedAt ?? p.createdAt)}</td>
                      {matching && <MatchCell match={matching.byPayment.get(p.id)} />}
                      <td>
                        <button className="btn-ghost btn-sm" onClick={() => setReviewing(p)}>
                          Revisar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {payments.length >= MAX_PENDING && <p className="px-3 py-2 text-xs text-warn">Se muestran las {MAX_PENDING} más recientes.</p>}
            </div>
          )
        }
      </QueryState>

      {matching && (
        <section aria-label="Líneas sin conciliar">
          <h2 className="mb-2 text-sm font-semibold">Créditos del extracto sin conciliar ({formatInt(matching.unmatchedLines.length)})</h2>
          {matching.unmatchedLines.length === 0 ? (
            <p className="text-sm text-ink-soft">Todos los créditos del extracto se emparejaron con un pago.</p>
          ) : (
            <div className="card overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Fila</th>
                    <th>Fecha</th>
                    <th className="num">Monto</th>
                    <th>Descripción</th>
                  </tr>
                </thead>
                <tbody>
                  {matching.unmatchedLines.map((l) => (
                    <tr key={l.index}>
                      <td className="text-xs text-ink-soft tabular-nums">{l.index + 1}</td>
                      <td className="text-xs whitespace-nowrap">{l.date ?? '—'}</td>
                      <td className="num">{formatMoney(l.amountCents / 100)}</td>
                      <td className="text-xs break-all">{l.description || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {reviewing && <VoucherModal payment={reviewing} line={matching ? (matching.byPayment.get(reviewing.id)?.line ?? null) : undefined} onClose={() => setReviewing(null)} />}

      <ConfirmDialog
        open={bulkOpen}
        title="Aprobar todos los exactos"
        confirmLabel={bulk ? `Aprobando ${bulk.done}/${bulk.total}…` : `Aprobar ${exact.length}`}
        danger={false}
        busy={!!bulk && bulk.done < bulk.total}
        onConfirm={() => void approveAllExact()}
        onClose={() => {
          if (!bulk || bulk.done >= bulk.total) setBulkOpen(false);
        }}
      >
        <p>
          Se aprobarán <strong>{formatInt(exact.length)}</strong> transferencia(s) por un total de <strong>{formatMoney(exactTotal)}</strong>: la referencia esperada aparece en el extracto y el monto
          coincide al centavo.
        </p>
        <p className="text-ink-soft">Cada pago queda capturado y su pedido pasa a preparación. No se puede deshacer.</p>
        {bulk && (
          <p role="status">
            Progreso: {bulk.done}/{bulk.total}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

function MatchCell({ match }: { match: MatchResult | undefined }) {
  if (!match) return <td />;
  const [label, tone] = MATCH_LABEL[match.kind];
  return (
    <td className="min-w-52 text-xs">
      <Badge tone={tone}>{label}</Badge>
      {match.line && (
        <div className="mt-1" title={match.reasons.join(' · ')}>
          <span className="tabular-nums">
            Fila {match.line.index + 1} · {match.line.date ?? 'sin fecha'} · {formatMoney(match.line.amountCents / 100)}
          </span>
          <span className="block max-w-64 truncate text-ink-soft">{match.line.description || '(sin descripción)'}</span>
          {match.kind === 'probable' && <span className="block text-ink-soft">{match.reasons.slice(1).join(' · ')}</span>}
        </div>
      )}
    </td>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`rounded-full border px-2.5 py-1 text-xs ${active ? 'border-ink bg-ink text-paper' : 'border-line bg-panel hover:border-ink'}`}>
      {children}
    </button>
  );
}

const HISTORY_LABEL: Record<string, [string, Tone]> = {
  captured: ['Aprobada', 'ok'],
  refunded: ['Aprobada · reembolsada', 'info'],
  partially_refunded: ['Aprobada · reembolso parcial', 'info'],
  failed: ['Rechazada', 'danger'],
};

function HistoryTab() {
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<'' | 'approved' | 'failed'>('');
  const [viewing, setViewing] = useState<TransferPayment | null>(null);
  const statuses = status === 'failed' ? ['failed'] : status === 'approved' ? ['captured', 'refunded', 'partially_refunded'] : [...HISTORY_STATUSES];
  const history = useQuery({
    queryKey: ['payments', 'transfers', 'history', { status, offset }],
    queryFn: ({ signal }) => api<TransferPayment[]>('/payments', { query: { method: 'transfer', status: statuses, limit: HISTORY_LIMIT, offset }, signal }),
    placeholderData: (prev) => prev,
  });
  return (
    <div>
      <div className="mb-3 max-w-xs">
        <label htmlFor="h-status" className="label">
          Resultado
        </label>
        <select
          id="h-status"
          className="input"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as typeof status);
            setOffset(0);
          }}
        >
          <option value="">Aprobadas y rechazadas</option>
          <option value="approved">Aprobadas</option>
          <option value="failed">Rechazadas</option>
        </select>
      </div>
      <QueryState query={history} loading="Cargando historial…">
        {(rows) =>
          rows.length === 0 && offset === 0 ? (
            <EmptyState title="Sin transferencias revisadas" />
          ) : (
            <>
              <div className="card overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Pedido</th>
                      <th className="num">Monto</th>
                      <th>Resultado</th>
                      <th>Revisada</th>
                      <th>Ref. cliente</th>
                      <th>Motivo</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => {
                      const [label, tone] = HISTORY_LABEL[p.status] ?? [p.status, 'neutral'];
                      return (
                        <tr key={p.id}>
                          <td className="font-medium whitespace-nowrap">{p.transfer?.orderNumber ?? p.orderId.slice(0, 8)}</td>
                          <td className="num">{formatMoney(p.amount)}</td>
                          <td>
                            <Badge tone={tone}>{label}</Badge>
                          </td>
                          <td className="text-xs whitespace-nowrap">{formatDateTime(p.transfer?.verifiedAt ?? p.capturedAt)}</td>
                          <td className="font-mono text-xs">{p.transfer?.reference ?? '—'}</td>
                          <td className="max-w-64 truncate text-xs" title={p.transfer?.rejectionReason ?? p.failureMessage ?? ''}>
                            {p.transfer?.rejectionReason ?? (p.status === 'failed' ? p.failureMessage : null) ?? '—'}
                          </td>
                          <td>
                            {p.transfer?.voucherSubmittedAt && (
                              <button className="btn-ghost btn-sm" onClick={() => setViewing(p)}>
                                Comprobante
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <SimplePager count={rows.length} limit={HISTORY_LIMIT} offset={offset} onChange={setOffset} />
            </>
          )
        }
      </QueryState>
      {viewing && <VoucherModal payment={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
