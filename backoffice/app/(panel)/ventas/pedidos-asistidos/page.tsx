'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { SimplePager } from '@/components/pedidos/SimplePager';
import { StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, QueryState } from '@/components/ui/States';
import { VoucherUploadModal } from '@/components/ventas/VoucherUploadModal';
import { api } from '@/lib/api/client';
import { canUploadVoucher } from '@/lib/assisted';
import { formatDateTime, formatMoney } from '@/lib/format';
import { FULFILLMENT_LABEL, ORDER_STATUS, orderNumberLabel, PAYMENT_METHOD_LABEL, PAYMENT_STATUS, type OrderSummary } from '@/lib/orders';

const LIMIT = 25;

const TABS = [
  { mine: true, label: 'Mis pedidos' },
  { mine: false, label: 'Todos (canal backoffice)' },
] as const;

/** Pedidos asistidos (GET /assisted-orders): los del vendedor o todos los del canal backoffice. */
export default function AssistedOrdersPage() {
  const [mine, setMine] = useState(true);
  const [offset, setOffset] = useState(0);
  const [voucherFor, setVoucherFor] = useState<{ id: string; number: string } | null>(null);

  const query = useQuery({
    queryKey: ['ventas', 'assisted-orders', { mine, offset }],
    queryFn: ({ signal }) => api<OrderSummary[]>('/assisted-orders', { query: { mine, limit: LIMIT, offset }, signal }),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <PageHeader
        title="Pedidos asistidos"
        description="Pedidos armados por el equipo a nombre de un cliente (teléfono, WhatsApp, tienda)."
        actions={
          <Link href="/ventas/pedidos-asistidos/nuevo" className="btn-primary">
            Nuevo pedido asistido
          </Link>
        }
      />

      <div className="mb-4 inline-flex rounded-md border border-line p-0.5" role="tablist" aria-label="Qué pedidos ver">
        {TABS.map((t) => (
          <button
            key={t.label}
            type="button"
            role="tab"
            aria-selected={mine === t.mine}
            className={`rounded px-3 py-1.5 text-sm ${mine === t.mine ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'}`}
            onClick={() => {
              setMine(t.mine);
              setOffset(0);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <QueryState query={query}>
        {(rows) =>
          rows.length === 0 && offset === 0 ? (
            <EmptyState title={mine ? 'Aún no has creado pedidos asistidos' : 'No hay pedidos del canal backoffice'}>
              <Link href="/ventas/pedidos-asistidos/nuevo" className="underline">
                Crear el primero
              </Link>
            </EmptyState>
          ) : (
            <>
              <div className="card overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Pedido</th>
                      <th>Cliente</th>
                      <th>Estado</th>
                      <th>Pago</th>
                      <th>Entrega</th>
                      <th className="num">Total</th>
                      <th>Fecha</th>
                      <th>
                        <span className="sr-only">Acciones</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <Link href={`/pedidos/${o.id}`} prefetch={false} className="font-medium underline-offset-2 hover:underline">
                            {orderNumberLabel(o)}
                          </Link>
                        </td>
                        <td>
                          <span className="block">{o.customer.name}</span>
                          <span className="block text-xs text-ink-soft">{o.customer.phone ?? o.customer.email}</span>
                        </td>
                        <td>
                          <StatusBadge status={o.status} map={ORDER_STATUS} />
                        </td>
                        <td>
                          <StatusBadge status={o.paymentStatus} map={PAYMENT_STATUS} />
                          <span className="block text-xs text-ink-soft">{PAYMENT_METHOD_LABEL[o.paymentMethod] ?? o.paymentMethod}</span>
                        </td>
                        <td className="text-sm">{FULFILLMENT_LABEL[o.fulfillmentType] ?? o.fulfillmentType}</td>
                        <td className="num">{formatMoney(o.total)}</td>
                        <td className="text-sm whitespace-nowrap">{formatDateTime(o.placedAt)}</td>
                        <td className="text-right">
                          {canUploadVoucher(o) && (
                            <button type="button" className="btn-ghost btn-sm whitespace-nowrap" onClick={() => setVoucherFor({ id: o.id, number: orderNumberLabel(o) })}>
                              Subir comprobante
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <SimplePager count={rows.length} limit={LIMIT} offset={offset} onChange={setOffset} />
            </>
          )
        }
      </QueryState>

      {voucherFor && <VoucherUploadModal open orderId={voucherFor.id} orderNumber={voucherFor.number} onClose={() => setVoucherFor(null)} />}
    </div>
  );
}
