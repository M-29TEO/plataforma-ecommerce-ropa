'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useWarehouseName } from '@/components/bodega/shared';
import { OrderDocuments } from '@/components/devoluciones/CreditNote';
import { OrderReturns } from '@/components/devoluciones/OrderReturns';
import { StatusActions } from '@/components/pedidos/StatusActions';
import { StatusTimeline } from '@/components/pedidos/StatusTimeline';
import { useCan } from '@/components/providers/AuthProvider';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryState } from '@/components/ui/States';
import { api, isApiError } from '@/lib/api/client';
import { formatDateTime, formatInt, formatMoney, toNumber } from '@/lib/format';
import { RESERVATION_STATUS, type Reservation } from '@/lib/inventory';
import {
  addressLines,
  CHANNEL_LABEL,
  FULFILLMENT_LABEL,
  ORDER_STATUS,
  orderNumberLabel,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS,
  type OrderDetail,
} from '@/lib/orders';

function Section({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card p-4 ${className}`}>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Pairs({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-soft">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Reservas de stock del pedido (GET /inventory/reservations?orderId), si el usuario ve inventario. */
function Reservations({ orderId, skus }: { orderId: string; skus: Map<string, string> }) {
  const warehouseName = useWarehouseName();
  const q = useQuery({
    queryKey: ['inventory', 'reservations', orderId],
    queryFn: async ({ signal }) => {
      try {
        return await api<Reservation[]>('/inventory/reservations', { query: { orderId }, signal });
      } catch (e) {
        if (isApiError(e, 'RESERVATION_NOT_FOUND')) return [];
        throw e;
      }
    },
  });
  if (q.isPending) return <p className="text-sm text-ink-soft">Cargando reservas…</p>;
  if (q.error) return <p className="text-sm text-ink-soft">No se pudieron cargar las reservas.</p>;
  if (q.data.length === 0) return <p className="text-sm text-ink-soft">El pedido no tiene reservas de stock.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {q.data.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-2">
          <StatusBadge status={r.status} map={RESERVATION_STATUS} />
          <span>
            {formatInt(r.quantity)} × <span className="font-mono">{skus.get(r.variantId) ?? r.variantId.slice(0, 8)}</span> en {warehouseName(r.warehouseId)}
          </span>
          {r.status === 'active' && <span className="text-xs text-ink-soft">vence {formatDateTime(r.expiresAt)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Detalle del pedido: ítems, totales, cliente, entrega, pago, historial y acciones de estado. */
export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const q = useQuery({
    queryKey: ['orders', 'detail', id],
    queryFn: ({ signal }) => api<OrderDetail>(`/orders/${id}`, { signal }),
  });

  return (
    <QueryState query={q}>
      {(o) => {
        const money = (v: string) => (toNumber(v) ? formatMoney(v) : null);
        return (
          <div>
            <PageHeader
              title={`Pedido ${orderNumberLabel(o)}`}
              back={{ href: '/pedidos', label: 'Pedidos' }}
              description={`${formatDateTime(o.placedAt)} · ${CHANNEL_LABEL[o.channel] ?? o.channel} · ${FULFILLMENT_LABEL[o.fulfillmentType] ?? o.fulfillmentType}`}
              actions={
                <>
                  <StatusBadge status={o.status} map={ORDER_STATUS} />
                  <StatusBadge status={o.paymentStatus} map={PAYMENT_STATUS} />
                </>
              }
            />

            <div className="mb-4">
              <StatusActions order={o} />
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="space-y-4 lg:col-span-2">
                <Section title={`Ítems (${o.items.length})`}>
                  <div className="-mx-4 overflow-x-auto">
                    <table className="table-base">
                      <thead>
                        <tr>
                          <th>Producto</th>
                          <th className="num">Cant.</th>
                          <th className="num">Precio</th>
                          <th className="num">Desc.</th>
                          <th className="num">IVA</th>
                          <th className="num">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {o.items.map((i) => (
                          <tr key={i.id}>
                            <td className="max-w-72">
                              <span className="block font-medium">{i.productName}</span>
                              <span className="block text-xs text-ink-soft">
                                {[i.brandName, i.colorName, i.sizeCode].filter(Boolean).join(' · ')}
                                {' · '}
                                <span className="font-mono">{i.sku}</span>
                              </span>
                              {i.qtyReturned > 0 && <Badge tone="warn">{i.qtyReturned} devuelta(s)</Badge>}
                            </td>
                            <td className="num">{formatInt(i.quantity)}</td>
                            <td className="num">{formatMoney(i.unitPrice)}</td>
                            <td className="num">{money(i.discount) ? `−${formatMoney(i.discount)}` : '—'}</td>
                            <td className="num text-xs text-ink-soft">
                              {formatMoney(i.taxAmount)}
                              <span className="block">{toNumber(i.taxRate) ?? 0}%</span>
                            </td>
                            <td className="num font-medium">{formatMoney(i.lineTotal)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 ml-auto max-w-xs">
                    <Pairs
                      rows={[
                        ['Subtotal', formatMoney(o.subtotal)],
                        ...(money(o.discountTotal) ? ([['Descuentos', `−${formatMoney(o.discountTotal)}`]] as [string, string][]) : []),
                        ['Envío', formatMoney(o.shippingTotal)],
                        ['IVA', formatMoney(o.taxTotal)],
                        ...(money(o.giftCardTotal) ? ([['Tarjeta de regalo', `−${formatMoney(o.giftCardTotal)}`]] as [string, string][]) : []),
                        ['Total', <strong key="t">{formatMoney(o.total)}</strong>],
                      ]}
                    />
                  </div>
                </Section>

                <Section title="Historial de estados">
                  <StatusTimeline history={o.history} />
                </Section>
              </div>

              <div className="space-y-4">
                <Section title="Cliente">
                  <Pairs
                    rows={[
                      ['Nombre', o.customer?.name || '—'],
                      ['Email', o.customer?.email ? <a href={`mailto:${o.customer.email}`} className="underline">{o.customer.email}</a> : '—'],
                      ['Teléfono', o.customer?.phone || '—'],
                      ...(o.customer?.idNumber ? ([['Identificación', `${o.customer.idType ?? ''} ${o.customer.idNumber}`.trim()]] as [string, string][]) : []),
                      ['Tipo', o.userId ? 'Registrado' : 'Invitado'],
                    ]}
                  />
                </Section>

                <Section title={o.fulfillmentType === 'pickup' ? 'Retiro en tienda' : 'Dirección de entrega'}>
                  {o.shippingAddress && addressLines(o.shippingAddress).length > 0 ? (
                    <Pairs rows={addressLines(o.shippingAddress)} />
                  ) : (
                    <p className="text-sm text-ink-soft">Sin dirección de envío.</p>
                  )}
                  {o.shippingCity && <p className="mt-2 text-sm">Ciudad: {o.shippingCity}</p>}
                  {o.shippingLocation && (
                    <a
                      className="mt-2 inline-block text-xs underline"
                      href={`https://www.openstreetmap.org/?mlat=${o.shippingLocation.lat}&mlon=${o.shippingLocation.lng}#map=17/${o.shippingLocation.lat}/${o.shippingLocation.lng}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Ver ubicación en OpenStreetMap
                    </a>
                  )}
                  {o.notes && <p className="mt-2 rounded bg-sand/60 px-2 py-1 text-sm">Nota: {o.notes}</p>}
                </Section>

                <Section title="Pago">
                  <Pairs
                    rows={[
                      ['Método', PAYMENT_METHOD_LABEL[o.paymentMethod] ?? o.paymentMethod],
                      ['Estado', <StatusBadge key="ps" status={o.paymentStatus} map={PAYMENT_STATUS} />],
                      ['Pagado', formatDateTime(o.paidAt)],
                      ['Moneda', o.currency],
                    ]}
                  />
                  {addressLines(o.billing).length > 0 && (
                    <>
                      <p className="mt-3 mb-1 text-xs font-medium text-ink-soft">Facturación</p>
                      <Pairs rows={addressLines(o.billing)} />
                    </>
                  )}
                </Section>

                <Section title="Fechas">
                  <Pairs
                    rows={[
                      ['Creado', formatDateTime(o.placedAt)],
                      ['Despachado', formatDateTime(o.shippedAt)],
                      ['Entregado', formatDateTime(o.deliveredAt)],
                      ...(o.cancelledAt ? ([['Cancelado', formatDateTime(o.cancelledAt)]] as [string, string][]) : []),
                    ]}
                  />
                  {o.cancelReason && <p className="mt-2 text-sm text-danger">Motivo de cancelación: {o.cancelReason}</p>}
                </Section>

                {can('returns.read') && (
                  <Section title="Devoluciones">
                    <OrderReturns order={o} />
                  </Section>
                )}

                {can('billing.read') && (
                  <Section title="Comprobantes electrónicos">
                    <OrderDocuments orderId={o.id} />
                  </Section>
                )}

                {can('inventory.read') && (
                  <Section title="Reservas de stock">
                    <Reservations orderId={o.id} skus={new Map(o.items.map((i) => [i.variantId, i.sku]))} />
                  </Section>
                )}
              </div>
            </div>
          </div>
        );
      }}
    </QueryState>
  );
}
