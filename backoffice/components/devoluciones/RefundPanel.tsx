'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/providers/ToastProvider';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { api, errorMessage, isApiError } from '@/lib/api/client';
import { formatDateTime, formatMoney, toNumber } from '@/lib/format';
import { REFUND_METHOD_LABEL, REFUND_PART_LABEL, REFUND_STATUS, type Refund, refundApproval } from '@/lib/returns';
import { returnKey } from './useReturnAction';

/** Quién aprobó: "tú" o un id corto (el módulo Pagos solo guarda el id del usuario). */
function who(userId: string, me: string | undefined): string {
  return userId === me ? 'tú' : `usuario ${userId.slice(0, 8)}`;
}

/**
 * Reembolso de la devolución (lo solicita la inspección): estado, método, aprobaciones ("1 de 2"
 * por encima de $100), plan de ejecución y partes completadas, con el botón Aprobar
 * (POST /refunds/:id/approve) para quien puede hacerlo.
 */
export function RefundPanel({ refund, returnId }: { refund: Refund; returnId: string }) {
  const { user, permissions } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const state = refundApproval(refund, user?.id, permissions);

  const approve = useMutation({
    mutationFn: () => api<Refund>(`/refunds/${refund.id}/approve`, { method: 'POST', body: {} }),
    onSuccess: (r) => {
      setConfirm(false);
      toast.ok(r.status === 'pending' ? `Primera aprobación registrada: falta la de otra persona (${r.approvals.length} de ${r.requiredApprovals})` : 'Reembolso aprobado');
      void qc.invalidateQueries({ queryKey: returnKey(returnId) });
      void qc.invalidateQueries({ queryKey: ['returns', 'list'] });
      void qc.invalidateQueries({ queryKey: ['orders', 'detail', r.orderId] });
    },
    onError: (e) => {
      if (isApiError(e, 'INVALID_REFUND_TRANSITION')) void qc.invalidateQueries({ queryKey: returnKey(returnId) });
    },
  });

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={refund.status} map={REFUND_STATUS} />
        <span className="text-lg font-semibold tabular-nums">{formatMoney(refund.amount)}</span>
      </div>
      <dl className="space-y-1.5">
        <Row label="Método">{REFUND_METHOD_LABEL[refund.method] ?? refund.method}</Row>
        <Row label="Aprobaciones">
          {state.done} de {state.required}
          {state.required > 1 && <span className="block text-xs text-ink-soft">Monto alto: dos personas distintas</span>}
        </Row>
        {refund.approvals.map((a, i) => (
          <Row key={a.userId} label={`Aprobó (${i + 1})`}>
            {who(a.userId, user?.id)}
            <span className="block text-xs text-ink-soft">{formatDateTime(a.at)}</span>
          </Row>
        ))}
        <Row label="Solicitado">{formatDateTime(refund.createdAt)}</Row>
        {refund.completedAt && <Row label="Completado">{formatDateTime(refund.completedAt)}</Row>}
      </dl>

      {refund.plan && (
        <div>
          <p className="mb-1 text-xs font-medium text-ink-soft">Cómo se devuelve</p>
          <ul className="space-y-0.5">
            {refund.plan.external && (
              <li>
                {refund.plan.external.kind === 'gateway' ? 'Reverso en la pasarela' : 'Transferencia bancaria'}: {formatMoney(refund.plan.external.amount)}
              </li>
            )}
            {(toNumber(refund.plan.giftCards) ?? 0) > 0 && <li>A las gift cards del pedido: {formatMoney(refund.plan.giftCards)}</li>}
            {(toNumber(refund.plan.storeCredit) ?? 0) > 0 && <li>Gift card nueva (saldo a favor): {formatMoney(refund.plan.storeCredit)}</li>}
          </ul>
          {refund.pendingParts.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-1">
              {refund.pendingParts.map((p) => (
                <Badge key={p} tone="warn">
                  Pendiente: {REFUND_PART_LABEL[p] ?? p}
                </Badge>
              ))}
            </p>
          )}
          {refund.plan.external?.kind === 'transfer' && refund.pendingParts.includes('external') && (
            <p className="mt-1 text-xs text-ink-soft">Falta que Finanzas registre la transferencia hecha al cliente.</p>
          )}
        </div>
      )}
      {refund.failureReason && <p className="text-danger">Falló: {refund.failureReason}</p>}

      {state.canApprove && (
        <button className="btn-primary btn-sm" onClick={() => setConfirm(true)}>
          {state.done > 0 ? 'Dar la segunda aprobación' : 'Aprobar reembolso'}
        </button>
      )}
      {!state.canApprove && state.blockedReason && <p className="text-xs text-ink-soft">{state.blockedReason}</p>}

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Aprobar reembolso"
        size="sm"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setConfirm(false)} disabled={approve.isPending}>
              Volver
            </button>
            <button className="btn-primary" onClick={() => approve.mutate()} disabled={approve.isPending}>
              {approve.isPending ? 'Aprobando…' : 'Aprobar'}
            </button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <p>
            Reembolso de <strong>{formatMoney(refund.amount)}</strong> por {REFUND_METHOD_LABEL[refund.method]?.toLowerCase() ?? refund.method}.
          </p>
          <p className="text-ink-soft">
            {state.required - state.done > 1
              ? 'Es un monto alto: después de tu aprobación hará falta la de otra persona.'
              : 'Con tu aprobación se ejecuta el reembolso (reverso, transferencia pendiente o gift card).'}
          </p>
          {approve.error ? (
            <p className="text-danger" role="alert">
              {errorMessage(approve.error)}
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
