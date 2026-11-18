'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/providers/ToastProvider';
import { Modal } from '@/components/ui/Modal';
import { api, errorMessage, isApiError } from '@/lib/api/client';
import { type AvailableTransition, availableTransitions, ORDER_STATUS, type OrderDetail } from '@/lib/orders';

/**
 * Botones de cambio de estado: SOLO las transiciones válidas para este pedido que el usuario tiene
 * permiso de hacer (lib/orders.ts). Cada cambio se confirma y viaja con la version leída.
 */
export function StatusActions({ order }: { order: OrderDetail }) {
  const { permissions, user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState<AvailableTransition | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const actions = availableTransitions(order, permissions, user?.type ?? 'staff');

  const change = useMutation({
    mutationFn: (t: AvailableTransition) =>
      api(`/orders/${order.id}/status`, {
        method: 'POST',
        body: { to: t.to, version: order.version, reason: reason.trim() || undefined },
      }),
    onSuccess: (_, t) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      toast.ok(`Pedido ${ORDER_STATUS[t.to][0].toLowerCase()}`);
      setPending(null);
      setReason('');
    },
    onError: (e) => {
      if (isApiError(e, 'STALE_VERSION') || isApiError(e, 'INVALID_ORDER_TRANSITION')) {
        void qc.invalidateQueries({ queryKey: ['orders', 'detail', order.id] });
      }
      setError(errorMessage(e));
    },
  });

  if (actions.length === 0) return null;

  const reasonOk = !pending?.reasonRequired || reason.trim().length >= 3;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <button
            key={a.to}
            className={a.danger ? 'btn-danger btn-sm' : 'btn-primary btn-sm'}
            onClick={() => {
              setError('');
              setReason('');
              setPending(a);
            }}
          >
            {a.label}
          </button>
        ))}
      </div>

      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending?.label ?? ''}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setPending(null)}>
              Volver
            </button>
            <button
              className={pending?.danger ? 'btn-danger' : 'btn-primary'}
              disabled={!reasonOk || change.isPending}
              onClick={() => pending && change.mutate(pending)}
            >
              {change.isPending ? 'Guardando…' : 'Confirmar'}
            </button>
          </>
        }
      >
        {pending && (
          <div className="space-y-3 text-sm">
            <p>
              El pedido pasará de <strong>{ORDER_STATUS[order.status][0]}</strong> a <strong>{ORDER_STATUS[pending.to][0]}</strong>.
              {pending.to === 'cancelled' && ' La cancelación no se puede deshacer.'}
              {pending.to === 'paid' && ' Úsalo solo con el pago verificado (p. ej. transferencia acreditada).'}
            </p>
            <div>
              <label htmlFor="status-reason" className="label">
                Motivo {pending.reasonRequired ? '(obligatorio)' : '(opcional)'}
              </label>
              <textarea
                id="status-reason"
                className="input"
                rows={2}
                maxLength={500}
                required={pending.reasonRequired}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {error && (
              <p className="text-danger" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
