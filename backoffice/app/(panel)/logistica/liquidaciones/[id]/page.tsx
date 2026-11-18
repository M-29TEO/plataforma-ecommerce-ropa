'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { DeliveryProofs } from '@/components/logistica/DeliveryProofs';
import { StatTile, useRiderNames } from '@/components/logistica/shared';
import { useAuth, useCan } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/providers/ToastProvider';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryState } from '@/components/ui/States';
import { api, errorMessage } from '@/lib/api/client';
import { formatDateTime, formatInt, formatMoney, toNumber } from '@/lib/format';
import {
  COD_METHOD_LABEL,
  formatDistance,
  formatWeek,
  normalizeMoneyInput,
  type RiderRatings,
  SETTLEMENT_STATUS,
  settlementActions,
  type SettlementDetail,
} from '@/lib/logistics';

type Dialog = 'approve' | 'dispute' | 'paid' | null;

/** Detalle de una liquidación: entregas, comisiones, efectivo y acciones según permiso y estado. */
export default function SettlementDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const { nameOf, byId } = useRiderNames();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [proofShipment, setProofShipment] = useState<string | null>(null);
  const [codRemitted, setCodRemitted] = useState('');
  const [reason, setReason] = useState('');

  const key = ['logistics', 'settlements', 'detail', id];
  const detail = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<SettlementDetail>(`/logistics/settlements/${id}`, { signal }),
  });
  const riderId = detail.data?.riderId;
  const ratings = useQuery({
    queryKey: ['logistics', 'riders', 'ratings', riderId],
    queryFn: ({ signal }) => api<RiderRatings>(`/logistics/riders/${riderId}/ratings`, { query: { limit: 10 }, signal }),
    enabled: !!riderId,
  });

  const done = (msg: string) => (s: SettlementDetail) => {
    qc.setQueryData(key, s);
    void qc.invalidateQueries({ queryKey: ['logistics', 'settlements', 'list'] });
    toast.ok(msg);
    setDialog(null);
  };
  const approve = useMutation({
    mutationFn: (amount: string) => api<SettlementDetail>(`/logistics/settlements/${id}/approve`, { method: 'POST', body: { codRemitted: amount } }),
    onSuccess: done('Liquidación aprobada.'),
  });
  const dispute = useMutation({
    mutationFn: (text: string) => api<SettlementDetail>(`/logistics/settlements/${id}/dispute`, { method: 'POST', body: { reason: text } }),
    onSuccess: done('Liquidación marcada en disputa.'),
  });
  const markPaid = useMutation({
    mutationFn: () => api<SettlementDetail>(`/logistics/settlements/${id}/mark-paid`, { method: 'POST' }),
    onSuccess: done('Liquidación marcada como pagada.'),
  });

  const open = (d: Dialog, s: SettlementDetail) => {
    approve.reset();
    dispute.reset();
    markPaid.reset();
    if (d === 'approve') setCodRemitted(Number(s.codCollected).toFixed(2));
    if (d === 'dispute') setReason('');
    setDialog(d);
  };

  return (
    <QueryState query={detail} loading="Cargando liquidación…">
      {(s) => {
        const actions = settlementActions(s.status);
        const canApprove = can('logistics.settlement.approve');
        const canManage = can('logistics.settlement.manage');
        const remitted = normalizeMoneyInput(codRemitted);
        const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 500;
        const rider = byId.get(s.riderId);
        const approvedByMe = !!s.approvedBy && s.approvedBy === user?.id;
        return (
          <div>
            <PageHeader
              back={{ href: '/logistica/liquidaciones', label: 'Liquidaciones' }}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {nameOf(s.riderId)} <StatusBadge status={s.status} map={SETTLEMENT_STATUS} />
                </span>
              }
              description={`Semana ${formatWeek(s.periodStart, s.periodEnd)}${rider?.phone ? ` · ${rider.phone}` : ''}`}
              actions={
                <>
                  {actions.dispute && canManage && (
                    <button className="btn-ghost" onClick={() => open('dispute', s)}>
                      Disputar
                    </button>
                  )}
                  {actions.approve && canApprove && (
                    <button className="btn-primary" onClick={() => open('approve', s)}>
                      Aprobar
                    </button>
                  )}
                  {actions.markPaid && canApprove && (
                    <button className="btn-accent" onClick={() => open('paid', s)}>
                      Marcar pagada
                    </button>
                  )}
                </>
              }
            />

            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <StatTile label="Entregas" value={formatInt(s.deliveriesCount)} />
              <StatTile label="Comisiones" value={formatMoney(s.grossFees)} hint={`Bonos ${formatMoney(s.bonuses)}`} />
              <StatTile label="Efectivo cobrado / remitido" value={`${formatMoney(s.codCollected)} / ${formatMoney(s.codRemitted)}`} hint={`Descuentos ${formatMoney(s.deductions)}`} />
              <StatTile label="Neto a pagar" value={formatMoney(s.netPayable)} hint={s.paidAt ? `Pagada ${formatDateTime(s.paidAt)}` : undefined} />
            </div>

            <div className="mt-3 card flex flex-wrap items-center gap-x-6 gap-y-1 px-3 py-2 text-sm">
              <span>
                Efectivo en mano: <strong className="tabular-nums">{formatMoney(s.cod.codBalance)}</strong> de {formatMoney(s.cod.codLimit)}
              </span>
              <span className="text-ink-soft">Disponible {formatMoney(s.cod.codAvailable)}</span>
              {s.cod.overLimit && <Badge tone="danger">⚠ Supera el tope de efectivo</Badge>}
            </div>

            <h2 className="mt-6 mb-2 text-sm font-semibold">Entregas ({s.items.length})</h2>
            <div className="card overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Entregado</th>
                    <th>Pedido</th>
                    <th className="num">Distancia</th>
                    <th>Cobro</th>
                    <th className="num">Efectivo</th>
                    <th className="num">Comisión</th>
                    <th>Prueba</th>
                  </tr>
                </thead>
                <tbody>
                  {s.items.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center text-ink-soft">
                        Sin entregas en esta liquidación.
                      </td>
                    </tr>
                  ) : (
                    s.items.map((i) => (
                      <tr key={i.shipmentId}>
                        <td className="text-xs whitespace-nowrap">{formatDateTime(i.deliveredAt)}</td>
                        <td className="font-mono text-xs">{i.orderId.slice(0, 8)}</td>
                        <td className="num">{formatDistance(i.distanceM)}</td>
                        <td>{i.codMethod ? (COD_METHOD_LABEL[i.codMethod] ?? i.codMethod) : 'Prepagado'}</td>
                        <td className="num">{toNumber(i.codAmount) ? formatMoney(i.codAmount) : '—'}</td>
                        <td className="num">{formatMoney(i.fee)}</td>
                        <td>
                          <button type="button" className="btn-ghost btn-sm" onClick={() => setProofShipment(i.shipmentId)}>
                            Ver
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <h2 className="mt-6 mb-2 text-sm font-semibold">
              Calificaciones de clientes {ratings.data?.ratingAvg && <span className="font-normal text-ink-soft">· promedio ★ {ratings.data.ratingAvg} ({formatInt(ratings.data.ratingCount)})</span>}
            </h2>
            {ratings.isPending ? (
              <p className="text-sm text-ink-soft">Cargando…</p>
            ) : ratings.error ? (
              <p className="text-sm text-danger">{errorMessage(ratings.error)}</p>
            ) : ratings.data && ratings.data.ratings.length > 0 ? (
              <ul className="card divide-y divide-line">
                {ratings.data.ratings.map((r) => (
                  <li key={r.id} className="px-3 py-2 text-sm">
                    <span aria-label={`${r.score} de 5`}>{'★'.repeat(r.score)}{'☆'.repeat(5 - r.score)}</span>
                    <span className="ml-2 text-xs text-ink-soft">{formatDateTime(r.createdAt)}</span>
                    {r.tags && r.tags.length > 0 && <span className="ml-2 text-xs text-ink-soft">{r.tags.join(', ')}</span>}
                    {r.comment && <p className="mt-0.5 text-ink-soft">{r.comment}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-soft">Sin calificaciones.</p>
            )}

            <Modal open={proofShipment !== null} onClose={() => setProofShipment(null)} title="Prueba de entrega" size="lg">
              {proofShipment && <DeliveryProofs shipmentId={proofShipment} />}
            </Modal>

            <Modal
              open={dialog === 'approve'}
              onClose={() => setDialog(null)}
              title="Aprobar liquidación"
              footer={
                <>
                  <button className="btn-ghost" onClick={() => setDialog(null)} disabled={approve.isPending}>
                    Cancelar
                  </button>
                  <button className="btn-primary" disabled={!remitted || approve.isPending} onClick={() => remitted && approve.mutate(remitted)}>
                    {approve.isPending ? 'Aprobando…' : 'Aprobar'}
                  </button>
                </>
              }
            >
              <form
                className="space-y-3 text-sm"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (remitted) approve.mutate(remitted);
                }}
              >
                <p>
                  Registra cuánto efectivo entregó el motorizado. Lo que falte de su saldo en mano ({formatMoney(s.cod.codBalance)}) se descuenta de sus comisiones y, si no alcanza, queda
                  como saldo para la próxima semana.
                </p>
                <div>
                  <label htmlFor="cod-remitted" className="label">
                    Efectivo remitido (USD)
                  </label>
                  <input
                    id="cod-remitted"
                    className="input"
                    inputMode="decimal"
                    required
                    value={codRemitted}
                    onChange={(e) => setCodRemitted(e.target.value)}
                    aria-invalid={!remitted}
                    aria-describedby="cod-remitted-help"
                  />
                  <p id="cod-remitted-help" className="mt-1 text-xs text-ink-soft">
                    Cobrado en la semana: {formatMoney(s.codCollected)}. Usa punto o coma para los centavos.
                  </p>
                </div>
                {approve.error && (
                  <p className="rounded-md bg-danger/10 px-3 py-2 text-danger" role="alert">
                    {errorMessage(approve.error)}
                  </p>
                )}
              </form>
            </Modal>

            <Modal
              open={dialog === 'dispute'}
              onClose={() => setDialog(null)}
              title="Disputar liquidación"
              footer={
                <>
                  <button className="btn-ghost" onClick={() => setDialog(null)} disabled={dispute.isPending}>
                    Cancelar
                  </button>
                  <button className="btn-danger" disabled={!reasonOk || dispute.isPending} onClick={() => dispute.mutate(reason.trim())}>
                    {dispute.isPending ? 'Enviando…' : 'Marcar en disputa'}
                  </button>
                </>
              }
            >
              <div className="space-y-3 text-sm">
                <p>La liquidación queda en disputa hasta que se recalcule o se apruebe. El motivo se registra en la auditoría.</p>
                <div>
                  <label htmlFor="dispute-reason" className="label">
                    Motivo (3 a 500 caracteres)
                  </label>
                  <textarea id="dispute-reason" className="input" rows={4} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} />
                  <p className="mt-1 text-right text-xs text-ink-soft">{reason.trim().length}/500</p>
                </div>
                {dispute.error && (
                  <p className="rounded-md bg-danger/10 px-3 py-2 text-danger" role="alert">
                    {errorMessage(dispute.error)}
                  </p>
                )}
              </div>
            </Modal>

            <ConfirmDialog
              open={dialog === 'paid'}
              title="Marcar como pagada"
              confirmLabel="Marcar pagada"
              danger={false}
              busy={markPaid.isPending}
              onConfirm={() => markPaid.mutate()}
              onClose={() => setDialog(null)}
            >
              <p>
                Confirma que transferiste <strong>{formatMoney(s.netPayable)}</strong> a {nameOf(s.riderId)}. Esta acción no se puede deshacer.
              </p>
              {approvedByMe && <p className="text-warn">Tú aprobaste esta liquidación: debe marcarla pagada otra persona.</p>}
              {markPaid.error && (
                <p className="rounded-md bg-danger/10 px-3 py-2 text-danger" role="alert">
                  {errorMessage(markPaid.error)}
                </p>
              )}
            </ConfirmDialog>
          </div>
        );
      }}
    </QueryState>
  );
}
