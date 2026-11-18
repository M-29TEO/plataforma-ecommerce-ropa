'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, isApiError } from '@/lib/api/client';
import type { OrderDetail, OrderShipment, ProductThumb } from '@/lib/commerce-types';
import { BROWSER_API } from '@/lib/config';
import { formatDate, formatMoney } from '@/lib/format';
import { canRequestReturn, type CustomerReturn, type CustomerReturnDetail, RETURN_STATUS_LABEL, returnDeadline } from '@/lib/returns';
import { getAccessToken } from '@/lib/api/client';
import { useToast } from '../providers/ToastProvider';
import { ORDER_STATUS_LABEL, ORDER_STEPS, PAYMENT_METHOD_LABEL, stepIndex } from './order-status';
import { ReturnRequestForm } from './ReturnRequestForm';
import { ReturnsList } from './ReturnsList';

export function OrderDetailView({ orderId }: { orderId: string }) {
  const toast = useToast();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [shipments, setShipments] = useState<OrderShipment[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, ProductThumb>>({});
  const [invoice, setInvoice] = useState<{ number: string; status: string } | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [returns, setReturns] = useState<CustomerReturn[]>([]);
  const [returning, setReturning] = useState(false);
  const [created, setCreated] = useState<CustomerReturnDetail | null>(null);
  const createdRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const o = await api<OrderDetail>(`/me/orders/${orderId}`);
      setOrder(o);
      const ids = [...new Set(o.items.map((i) => i.productId))];
      const [s, t, inv, r] = await Promise.all([
        api<OrderShipment[]>(`/me/orders/${orderId}/shipments`).catch(() => []),
        ids.length ? api<ProductThumb[]>(`/catalog/product-thumbs?ids=${ids.join(',')}`).catch(() => []) : Promise.resolve([]),
        api<{ number: string; status: string }>(`/me/orders/${orderId}/invoice`).catch(() => null),
        api<CustomerReturn[]>(`/me/returns?orderId=${orderId}&limit=50`).catch(() => []),
      ]);
      setShipments(s);
      setThumbs(Object.fromEntries(t.map((x) => [x.id, x])));
      setInvoice(inv);
      setReturns(r);
    } catch (e) {
      if (isApiError(e) && e.status === 404) setNotFound(true);
      else toast(errorMessage(e), 'error');
    }
  }, [orderId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancel() {
    if (!order) return;
    const reason = window.prompt('¿Por qué cancelas el pedido?', 'Ya no lo necesito');
    if (!reason || reason.trim().length < 3) return;
    setCancelling(true);
    try {
      await api(`/me/orders/${order.id}/cancel`, { method: 'POST', body: { version: order.version, reason: reason.trim() } });
      toast('Pedido cancelado', 'ok');
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setCancelling(false);
    }
  }

  /** El RIDE se descarga con el token en el header (no viaja en la URL). */
  async function downloadInvoice() {
    const res = await fetch(`${BROWSER_API}/me/orders/${orderId}/invoice/ride.pdf`, { headers: { Authorization: `Bearer ${getAccessToken()}` }, credentials: 'include' });
    if (!res.ok) {
      toast('La factura todavía no está autorizada por el SRI', 'error');
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /** Solicitud enviada: se cierra el formulario, se muestra el RMA (con foco) y se recargan las devoluciones. */
  function onReturnCreated(ret: CustomerReturnDetail) {
    setReturning(false);
    setCreated(ret);
    void load();
    requestAnimationFrame(() => createdRef.current?.focus());
  }

  if (notFound) return <p className="text-ink-soft">No encontramos este pedido.</p>;
  if (!order) return <p className="text-ink-soft">Cargando pedido…</p>;

  const step = stepIndex(order.status);
  const live = shipments.find((s) => s.direction === 'outbound' && s.carrierType !== 'pickup');
  const address = order.shippingAddress as Record<string, string> | null;
  const returnable = canRequestReturn(order, returns);
  const deadline = returnDeadline(order.deliveredAt);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/mi-cuenta/pedidos" className="text-sm text-ink-soft hover:underline">
            ← Mis pedidos
          </Link>
          <h1 className="mt-1 text-3xl">Pedido #{order.orderNumber}</h1>
          <p className="text-sm text-ink-soft">
            {formatDate(order.placedAt, { dateStyle: 'long', timeStyle: 'short' })} · {PAYMENT_METHOD_LABEL[order.paymentMethod] ?? order.paymentMethod}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {live && order.status !== 'cancelled' && (
            <Link href={`/seguimiento/${live.trackingToken}`} className="btn-accent">
              {['shipped', 'in_transit'].includes(order.status) ? 'Seguir en vivo' : 'Ver seguimiento'}
            </Link>
          )}
          {invoice && (
            <button type="button" className="btn-ghost" onClick={() => void downloadInvoice()}>
              Factura {invoice.number}
            </button>
          )}
          {returnable && !returning && (
            <button type="button" className="btn-ghost" onClick={() => setReturning(true)}>
              Solicitar devolución o cambio
            </button>
          )}
          {(order.status === 'created' || order.status === 'paid') && (
            <button type="button" className="btn-ghost text-danger" onClick={() => void cancel()} disabled={cancelling}>
              Cancelar pedido
            </button>
          )}
        </div>
      </div>

      {order.status === 'cancelled' ? (
        <p className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger">Pedido cancelado{order.cancelReason ? `: ${order.cancelReason}` : ''}.</p>
      ) : (
        <ol className="grid grid-cols-5 gap-2" aria-label="Estado del pedido">
          {ORDER_STEPS.map((s, i) => (
            <li key={s} className="text-center text-xs">
              <span className={`mx-auto mb-1 block h-1.5 rounded-full ${i <= step ? 'bg-accent' : 'bg-line'}`} />
              <span className={i === step ? 'font-semibold' : 'text-ink-soft'} aria-current={i === step ? 'step' : undefined}>
                {ORDER_STATUS_LABEL[s]}
              </span>
            </li>
          ))}
        </ol>
      )}

      {created && (
        <div ref={createdRef} tabIndex={-1} role="status" className="rounded-lg bg-ok/10 px-4 py-3 text-sm outline-none">
          <p className="font-semibold">Solicitud {created.rmaNumber} enviada</p>
          <p>
            Estado: {RETURN_STATUS_LABEL[created.status]}. Te avisaremos por email cuando la revisemos y programemos el retiro.{' '}
            <Link href={`/mi-cuenta/devoluciones/${created.id}`} className="underline">
              Ver la devolución
            </Link>
          </p>
        </div>
      )}

      {returning && <ReturnRequestForm order={order} thumbs={thumbs} returns={returns} onCreated={onReturnCreated} onCancel={() => setReturning(false)} />}

      {returnable && !returning && deadline && (
        <p className="text-sm text-ink-soft">
          Puedes pedir una devolución o un cambio de talla hasta el {formatDate(deadline, { dateStyle: 'long' })}.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <ul className="card divide-y divide-line">
          {order.items.map((it) => {
            const t = thumbs[it.productId];
            const img = t?.images.find((m) => m.colorName === it.colorName) ?? t?.images[0];
            return (
              <li key={it.id} className="flex gap-4 p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {img ? <img src={img.url} alt="" className="h-24 w-20 rounded-lg object-cover" /> : <span className="h-24 w-20 rounded-lg bg-sand" />}
                <div className="flex-1">
                  {t ? (
                    <Link href={`/producto/${t.slug}`} className="font-medium hover:underline">
                      {it.productName}
                    </Link>
                  ) : (
                    <p className="font-medium">{it.productName}</p>
                  )}
                  <p className="text-xs text-ink-soft">{[it.colorName, it.sizeCode && `Talla ${it.sizeCode}`, `Cantidad ${it.quantity}`].filter(Boolean).join(' · ')}</p>
                  {order.status === 'delivered' && t && (
                    <Link href={`/producto/${t.slug}#resenas`} className="mt-2 inline-block text-xs underline">
                      Escribir una reseña
                    </Link>
                  )}
                </div>
                <p className="font-medium">{formatMoney(it.lineTotal)}</p>
              </li>
            );
          })}
        </ul>
        <div className="space-y-4">
          <dl className="card space-y-1.5 p-4 text-sm">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
              <dd>{formatMoney(order.subtotal)}</dd>
            </div>
            {Number(order.discountTotal) > 0 && (
              <div className="flex justify-between text-ok">
                <dt>Descuentos</dt>
                <dd>-{formatMoney(order.discountTotal)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt>Envío</dt>
              <dd>{Number(order.shippingTotal) === 0 ? 'Gratis' : formatMoney(order.shippingTotal)}</dd>
            </div>
            <div className="flex justify-between text-ink-soft">
              <dt>IVA</dt>
              <dd>{formatMoney(order.taxTotal)}</dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2 font-semibold">
              <dt>Total</dt>
              <dd>{formatMoney(order.total)}</dd>
            </div>
          </dl>
          {address && (
            <div className="card p-4 text-sm">
              <p className="font-semibold">Entrega</p>
              <p className="mt-1 text-ink-soft">
                {[address.mainStreet, address.secondaryStreet].filter(Boolean).join(' y ')} {address.number}
                <br />
                {address.city}
              </p>
            </div>
          )}
        </div>
      </div>

      {returns.length > 0 && (
        <section aria-labelledby="order-returns-title">
          <h2 id="order-returns-title" className="mb-3 text-xl">
            Devoluciones de este pedido
          </h2>
          <ReturnsList returns={returns} />
        </section>
      )}
    </div>
  );
}
