'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useToast } from '@/components/providers/ToastProvider';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/States';
import { api, apiBlob, errorMessage, isApiError, saveBlob } from '@/lib/api/client';
import { formatDateTime, formatMoney } from '@/lib/format';
import type { StatementLine, TransferPayment } from '@/lib/reconciliation';

/** Comprobante como object URL (se libera al cerrar). */
function useVoucher(paymentId: string) {
  const q = useQuery({
    queryKey: ['payments', 'voucher', paymentId],
    queryFn: ({ signal }) => apiBlob(`/payments/${paymentId}/transfer/voucher`, { signal }),
    staleTime: Infinity,
    gcTime: 0,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const u = URL.createObjectURL(q.data.blob);
    // El object URL se crea y se libera con el blob (StrictMode repite el efecto: no sirve un useMemo).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [q.data]);
  return { ...q, url };
}

function VoucherView({ payment }: { payment: TransferPayment }) {
  const v = useVoucher(payment.id);
  if (v.isPending) return <Spinner label="Cargando comprobante…" />;
  if (v.error || !v.data) return <ErrorState error={v.error} onRetry={() => void v.refetch()} />;
  const type = v.data.blob.type;
  const name = v.data.filename ?? `comprobante-${payment.transfer?.orderNumber ?? payment.id.slice(0, 8)}`;
  return (
    <div>
      {v.url && type.startsWith('image/') && (
        // eslint-disable-next-line @next/next/no-img-element -- object URL local, sin optimización
        <img src={v.url} alt="Comprobante de transferencia" className="max-h-[55dvh] w-full rounded-md border border-line object-contain" />
      )}
      {v.url && type === 'application/pdf' && <iframe src={v.url} title="Comprobante de transferencia (PDF)" className="h-[55dvh] w-full rounded-md border border-line" />}
      {!type.startsWith('image/') && type !== 'application/pdf' && <p className="text-sm text-ink-soft">Formato sin vista previa ({type || 'desconocido'}).</p>}
      <button className="btn-ghost btn-sm mt-2" onClick={() => saveBlob(v.data.blob, name)}>
        Descargar comprobante
      </button>
    </div>
  );
}

/**
 * Revisión de una transferencia: comprobante, datos que declaró el cliente, la línea del
 * extracto con que se emparejó (si hay) y aprobar o rechazar con motivo.
 */
export function VoucherModal({ payment, line, onClose }: { payment: TransferPayment; line?: StatementLine | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [rejecting, setRejecting] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [reason, setReason] = useState('');
  const t = payment.transfer;
  const pending = payment.status === 'pending';

  const finish = (msg: string) => {
    toast.ok(msg);
    void qc.invalidateQueries({ queryKey: ['payments', 'transfers'] });
    onClose();
  };
  const approve = useMutation({
    mutationFn: () => api<unknown>(`/payments/${payment.id}/transfer/approve`, { method: 'POST' }),
    onSuccess: () => finish('Transferencia aprobada.'),
  });
  const reject = useMutation({
    mutationFn: () => api<unknown>(`/payments/${payment.id}/transfer/reject`, { method: 'POST', body: { reason: reason.trim() } }),
    onSuccess: () => finish('Transferencia rechazada.'),
  });
  const err = approve.error ?? reject.error;
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 500;
  const busy = approve.isPending || reject.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={`Transferencia del pedido ${t?.orderNumber ?? payment.orderId.slice(0, 8)}`}
      footer={
        !pending ? (
          <button className="btn-ghost" onClick={onClose}>
            Cerrar
          </button>
        ) : rejecting ? (
          <>
            <button className="btn-ghost" onClick={() => setRejecting(false)} disabled={busy}>
              Volver
            </button>
            <button className="btn-danger" disabled={!reasonOk || busy} onClick={() => reject.mutate()}>
              {reject.isPending ? 'Rechazando…' : 'Confirmar rechazo'}
            </button>
          </>
        ) : confirmApprove ? (
          <>
            <button className="btn-ghost" onClick={() => setConfirmApprove(false)} disabled={busy}>
              Volver
            </button>
            <button className="btn-primary" disabled={busy} onClick={() => approve.mutate()}>
              {approve.isPending ? 'Aprobando…' : `Sí, aprobar ${formatMoney(payment.amount)}`}
            </button>
          </>
        ) : (
          <>
            <button className="btn-ghost" onClick={() => setRejecting(true)}>
              Rechazar
            </button>
            <button className="btn-primary" onClick={() => setConfirmApprove(true)}>
              Aprobar
            </button>
          </>
        )
      }
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
        <VoucherView payment={payment} />
        <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-ink-soft">Monto</dt>
            <dd className="font-semibold tabular-nums">{formatMoney(payment.amount)}</dd>
            <dt className="text-ink-soft">Ref. esperada</dt>
            <dd className="font-mono">{t?.expectedReference ?? '—'}</dd>
            <dt className="text-ink-soft">Banco</dt>
            <dd>{t?.bankName ?? '—'}</dd>
            <dt className="text-ink-soft">Ref. cliente</dt>
            <dd className="font-mono break-all">{t?.reference ?? '—'}</dd>
            <dt className="text-ink-soft">Subido</dt>
            <dd>{formatDateTime(t?.voucherSubmittedAt)}</dd>
            <dt className="text-ink-soft">Vence</dt>
            <dd>{formatDateTime(payment.expiresAt)}</dd>
          </dl>
          {line !== undefined && (
            <div className="rounded-md border border-line bg-sand/40 px-3 py-2">
              <p className="text-xs font-semibold text-ink-soft uppercase">Línea del extracto</p>
              {line ? (
                <p className="mt-1">
                  {line.date ?? 'Sin fecha'} · <span className="tabular-nums">{formatMoney(line.amountCents / 100)}</span>
                  <br />
                  <span className="text-xs break-all text-ink-soft">{line.description || '(sin descripción)'}</span>
                </p>
              ) : (
                <p className="mt-1 text-ink-soft">Sin coincidencia en el extracto.</p>
              )}
            </div>
          )}
          {!pending && t?.verifiedAt && (
            <p className="text-ink-soft">
              Revisada {formatDateTime(t.verifiedAt)}
              {t.rejectionReason && <> · Motivo: {t.rejectionReason}</>}
            </p>
          )}
          {rejecting && (
            <div>
              <label htmlFor="reject-reason" className="label">
                Motivo del rechazo (lo verá el cliente; 3 a 500 caracteres)
              </label>
              <textarea id="reject-reason" className="input" rows={3} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
          {confirmApprove && <p className="rounded-md bg-sand px-3 py-2">Al aprobar, el pago queda capturado y el pedido pasa a preparación. No se puede deshacer.</p>}
          {err && (
            <p className="rounded-md bg-danger/10 px-3 py-2 text-danger" role="alert">
              {isApiError(err, 'VOUCHER_NOT_SUBMITTED') ? 'El cliente todavía no subió el comprobante.' : errorMessage(err)}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
