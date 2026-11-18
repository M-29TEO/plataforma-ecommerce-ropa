'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useCan } from '@/components/providers/AuthProvider';
import { ErrorState } from '@/components/ui/States';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/lib/api/client';
import { formatDateTime, formatMoney } from '@/lib/format';
import { ORDER_STATUS_LABELS, type LinkedOrder as Order } from '@/lib/support';

/** Pedido vinculado al ticket: resumen (si tiene orders.read) y enlace a su ficha. */
export function LinkedOrder({ orderId, shipmentId }: { orderId: string; shipmentId: string | null }) {
  const can = useCan();
  const allowed = can('orders.read');
  const q = useQuery({
    queryKey: ['orders', 'detail', orderId],
    queryFn: ({ signal }) => api<Order>(`/orders/${orderId}`, { signal }),
    enabled: allowed,
    staleTime: 60_000,
  });

  if (!allowed) {
    return <p className="text-sm text-ink-soft">Pedido {orderId.slice(0, 8)}… (tu rol no puede ver pedidos)</p>;
  }
  if (q.isPending) return <Spinner />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  return (
    <dl className="space-y-1.5 text-sm">
      <Row label="Pedido">
        <Link href={`/pedidos/${o.id}`} className="font-medium underline underline-offset-2">
          #{o.orderNumber ?? o.id.slice(0, 8)}
        </Link>
      </Row>
      <Row label="Estado">{ORDER_STATUS_LABELS[o.status] ?? o.status}</Row>
      <Row label="Total">{formatMoney(o.total)}</Row>
      <Row label="Cliente">{o.customer?.name || '—'}</Row>
      <Row label="Comprado">{formatDateTime(o.placedAt)}</Row>
      {o.deliveredAt && <Row label="Entregado">{formatDateTime(o.deliveredAt)}</Row>}
      {shipmentId && <Row label="Envío">{shipmentId.slice(0, 8)}…</Row>}
    </dl>
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
