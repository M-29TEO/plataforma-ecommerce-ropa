'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { StatusBadge } from '@/components/ui/Badge';
import { api, errorMessage } from '@/lib/api/client';
import { formatDate, formatMoney } from '@/lib/format';
import type { OrderDetail } from '@/lib/orders';
import { canRegisterReturn, RETURN_STATUS, RETURN_TYPE_LABEL, returnableQuantities, returnsQuery, type ReturnSummary, unitsOf } from '@/lib/returns';
import { RegisterReturnModal } from './RegisterReturnModal';

/** Las devoluciones de un pedido caben en una página (una por solicitud; el API admite hasta 100). */
const LIMIT = 100;

/**
 * Devoluciones del pedido (GET /returns?orderId=) y el botón "Registrar devolución" para soporte
 * (returns.approve, pedido entregado). Lo devolvible descuenta lo que ya está en solicitudes abiertas.
 */
export function OrderReturns({ order }: { order: OrderDetail }) {
  const { permissions } = useAuth();
  const [open, setOpen] = useState(false);
  const query = returnsQuery('', LIMIT, 0, order.id);
  const q = useQuery({
    queryKey: ['returns', 'order', order.id],
    queryFn: ({ signal }) => api<ReturnSummary[]>('/returns', { query, signal }),
  });
  const canRegister = canRegisterReturn(order, permissions);
  const available = returnableQuantities(order.items, q.data ?? []);
  const anyAvailable = [...available.values()].some((n) => n > 0);

  return (
    <div className="space-y-3">
      {q.isPending ? (
        <p className="text-sm text-ink-soft">Cargando devoluciones…</p>
      ) : q.error ? (
        <p className="text-sm text-danger">{errorMessage(q.error) || 'No se pudieron cargar las devoluciones.'}</p>
      ) : q.data.length === 0 ? (
        <p className="text-sm text-ink-soft">El pedido no tiene devoluciones.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {q.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0">
                <Link href={`/devoluciones/${r.id}`} prefetch={false} className="font-medium underline-offset-2 hover:underline">
                  {r.rmaNumber}
                </Link>
                <span className="block text-xs text-ink-soft">
                  {RETURN_TYPE_LABEL[r.type]} · {unitsOf(r)} unid. · {formatDate(r.createdAt)}
                  {r.refundAmount ? ` · ${formatMoney(r.refundAmount)}` : ''}
                </span>
              </span>
              <StatusBadge status={r.status} map={RETURN_STATUS} />
            </li>
          ))}
        </ul>
      )}

      {canRegister && (
        <>
          <button className="btn-primary btn-sm" disabled={q.isPending || !anyAvailable} onClick={() => setOpen(true)} title={anyAvailable ? undefined : 'No quedan unidades por devolver'}>
            Registrar devolución
          </button>
          {open && <RegisterReturnModal order={order} available={available} onClose={() => setOpen(false)} />}
        </>
      )}
    </div>
  );
}
