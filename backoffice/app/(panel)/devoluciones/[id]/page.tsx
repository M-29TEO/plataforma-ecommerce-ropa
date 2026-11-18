'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useWarehouseName, VariantName } from '@/components/bodega/shared';
import { CreditNote } from '@/components/devoluciones/CreditNote';
import { RefundPanel } from '@/components/devoluciones/RefundPanel';
import { ReturnActionsBar } from '@/components/devoluciones/ReturnActions';
import { ReturnPhotos } from '@/components/devoluciones/ReturnPhotos';
import { returnKey } from '@/components/devoluciones/useReturnAction';
import { useCan } from '@/components/providers/AuthProvider';
import { useResolveVariants } from '@/components/scanner/variant-cache';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryState } from '@/components/ui/States';
import { api } from '@/lib/api/client';
import { formatDateTime, formatMoney, toNumber } from '@/lib/format';
import { SHIPMENT_STATUS } from '@/lib/logistics';
import { ORDER_STATUS, PAYMENT_METHOD_LABEL, type PaymentMethod } from '@/lib/orders';
import {
  CONDITION_LABEL,
  REASON_LABEL,
  RESOLUTION_LABEL,
  RETURN_STATUS,
  RETURN_TYPE_LABEL,
  type ReturnDetail,
  type ReturnShipment,
  SHIPPING_PAID_BY_LABEL,
} from '@/lib/returns';

/** Permisos con los que el catálogo resuelve nombres de variantes (VARIANT_LOOKUP_PERMISSIONS). */
const VARIANT_LOOKUP = ['inventory.read', 'catalog.product.write', 'orders.assisted.create', 'inventory.picking'];

/** Nombres de la talla nueva de un cambio, si el rol puede consultar variantes. */
function ExchangeVariants({ ids }: { ids: string[] }) {
  useResolveVariants(ids);
  return null;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="mb-3 text-xs font-semibold tracking-wide text-ink-soft uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-right break-words">{children}</dd>
    </div>
  );
}

/** Nombre de la bodega (la lista es de Inventario: solo se pide si el rol la ve). */
function WarehouseName({ id }: { id: string }) {
  const name = useWarehouseName();
  return <>{name(id)}</>;
}

function Shipment({ s, showWarehouse }: { s: ReturnShipment; showWarehouse: boolean }) {
  return (
    <dl className="space-y-1.5 text-sm">
      <Row label="Estado">
        <StatusBadge status={s.status} map={SHIPMENT_STATUS} />
      </Row>
      <Row label="Transporte">{s.carrierType === 'rider' ? 'Motorizado' : s.carrierType === 'courier' ? 'Courier' : s.carrierType === 'store' ? 'En tienda' : s.carrierType}</Row>
      {s.originWarehouseId && <Row label="Bodega">{showWarehouse ? <WarehouseName id={s.originWarehouseId} /> : `Bodega ${s.originWarehouseId.slice(0, 8)}`}</Row>}
      {toNumber(s.priceCharged) ? <Row label="Costo">{formatMoney(s.priceCharged)}</Row> : null}
      {s.deliveredAt && <Row label="Entregado">{formatDateTime(s.deliveredAt)}</Row>}
    </dl>
  );
}

/** Ficha de la devolución: líneas con motivo y fotos, acciones según estado, retiro, reembolso y nota de crédito. */
export default function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const showWarehouse = can('inventory.read');
  const q = useQuery({
    queryKey: returnKey(id),
    queryFn: ({ signal }) => api<ReturnDetail>(`/returns/${id}`, { signal }),
  });
  const canLookup = VARIANT_LOOKUP.some(can);

  return (
    <QueryState query={q} loading="Cargando la devolución…">
      {(r) => {
        const exchangeIds = r.lines.map((l) => l.exchangeVariantId).filter((v): v is string => !!v);
        const total = r.lines.reduce((s, l) => s + (toNumber(l.total) ?? 0), 0);
        return (
          <div>
            {canLookup && exchangeIds.length > 0 && <ExchangeVariants ids={exchangeIds} />}
            <PageHeader
              back={{ href: '/devoluciones', label: 'Devoluciones' }}
              title={
                <>
                  {r.rmaNumber} <span className="text-ink-soft">· {RETURN_TYPE_LABEL[r.type]}</span>
                </>
              }
              description={
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={r.status} map={RETURN_STATUS} />
                  <Badge>{RESOLUTION_LABEL[r.resolution] ?? r.resolution}</Badge>
                  <Badge>Retiro lo paga: {SHIPPING_PAID_BY_LABEL[r.returnShippingPaidBy] ?? r.returnShippingPaidBy}</Badge>
                  <span className="text-xs">Solicitada {formatDateTime(r.createdAt)}</span>
                </span>
              }
            />

            <div className="mb-4">
              <ReturnActionsBar ret={r} />
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="min-w-0 space-y-4">
                <Panel title="Motivo">
                  <p className="text-sm whitespace-pre-wrap">{r.reason}</p>
                  {r.customerNotes && <blockquote className="mt-2 border-l-2 border-line pl-3 text-sm whitespace-pre-wrap text-ink-soft">{r.customerNotes}</blockquote>}
                </Panel>

                <Panel title={`Productos (${r.lines.length})`}>
                  <ul className="divide-y divide-line">
                    {r.lines.map((l) => (
                      <li key={l.returnItemId} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium">{l.productName}</p>
                            <p className="text-xs text-ink-soft">
                              {[l.colorName, l.sizeCode].filter(Boolean).join(' · ')} · <span className="font-mono">{l.sku}</span>
                            </p>
                            <p className="mt-1 flex flex-wrap gap-1">
                              <Badge tone="accent">{REASON_LABEL[l.reasonCode] ?? l.reasonCode}</Badge>
                              {l.condition && <Badge tone={l.condition === 'damaged' ? 'danger' : l.condition === 'used' ? 'warn' : 'ok'}>{CONDITION_LABEL[l.condition]}</Badge>}
                              {l.restock !== null && <Badge tone={l.restock ? 'ok' : 'neutral'}>{l.restock ? 'Volvió al stock' : 'No vuelve al stock'}</Badge>}
                            </p>
                            {l.exchangeVariantId && (
                              <div className="mt-1 text-sm">
                                <span className="text-ink-soft">Cambia por:</span> <VariantName variantId={l.exchangeVariantId} compact />
                              </div>
                            )}
                          </div>
                          <div className="text-right text-sm tabular-nums">
                            <p>
                              {l.quantity} × {formatMoney(l.unitPrice)}
                            </p>
                            {toNumber(l.discount) ? <p className="text-xs text-ink-soft">Desc. −{formatMoney(l.discount)}</p> : null}
                            <p className="text-xs text-ink-soft">IVA {formatMoney(l.taxAmount)}</p>
                            <p className="font-medium">{formatMoney(l.total)}</p>
                          </div>
                        </div>
                        <ReturnPhotos returnId={r.id} returnItemId={l.returnItemId} count={l.photos.length} productName={l.productName} />
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex justify-end gap-6 border-t border-line pt-3 text-sm">
                    <span className="text-ink-soft">Valor de lo devuelto (IVA incl.)</span>
                    <strong className="tabular-nums">{formatMoney(total)}</strong>
                  </div>
                  {r.refundAmount && (
                    <p className="mt-1 text-right text-sm">
                      Monto a reembolsar: <strong>{formatMoney(r.refundAmount)}</strong>
                    </p>
                  )}
                </Panel>
              </div>

              <aside className="space-y-4">
                <Panel title="Pedido">
                  <dl className="space-y-1.5 text-sm">
                    <Row label="Número">
                      <Link href={`/pedidos/${r.orderId}`} className="underline">
                        #{r.order.orderNumber}
                      </Link>
                    </Row>
                    <Row label="Estado">
                      <StatusBadge status={r.order.status} map={ORDER_STATUS} />
                    </Row>
                    <Row label="Pago">{PAYMENT_METHOD_LABEL[r.order.paymentMethod as PaymentMethod] ?? r.order.paymentMethod}</Row>
                    <Row label="Cliente">{r.order.customer.name || '—'}</Row>
                    {r.order.customer.email && <Row label="Email">{r.order.customer.email}</Row>}
                    {r.order.customer.phone && <Row label="Teléfono">{r.order.customer.phone}</Row>}
                    <Row label="Tipo">{r.order.userId ? 'Registrado' : 'Invitado'}</Row>
                  </dl>
                </Panel>

                <Panel title="Retiro">
                  {r.pickupShipment ? (
                    <Shipment s={r.pickupShipment} showWarehouse={showWarehouse} />
                  ) : (
                    <p className="text-sm text-ink-soft">{r.status === 'requested' ? 'Se programa al aprobar.' : 'Sin envío de retiro.'}</p>
                  )}
                </Panel>

                {r.type === 'exchange' && (
                  <Panel title="Envío del cambio">
                    {r.exchangeShipment ? (
                      <Shipment s={r.exchangeShipment} showWarehouse={showWarehouse} />
                    ) : (
                      <p className="text-sm text-ink-soft">
                        {r.status === 'inspected' ? 'Pendiente: no había stock de la talla nueva al inspeccionar.' : 'Se despacha al inspeccionar la devolución.'}
                      </p>
                    )}
                  </Panel>
                )}

                {r.type === 'return' && (
                  <Panel title="Reembolso">
                    {r.refund ? (
                      <RefundPanel refund={r.refund} returnId={r.id} />
                    ) : (
                      <p className="text-sm text-ink-soft">{r.status === 'closed' ? 'Sin monto a reembolsar.' : 'Se solicita al inspeccionar la devolución.'}</p>
                    )}
                  </Panel>
                )}

                {r.type === 'return' && can('billing.read') && (
                  <Panel title="Nota de crédito">
                    <CreditNote returnId={r.id} />
                  </Panel>
                )}

                <Panel title="Fechas">
                  <dl className="space-y-1.5 text-sm">
                    <Row label="Solicitada">{formatDateTime(r.createdAt)}</Row>
                    {r.closedAt && <Row label="Cerrada">{formatDateTime(r.closedAt)}</Row>}
                  </dl>
                </Panel>
              </aside>
            </div>
          </div>
        );
      }}
    </QueryState>
  );
}
