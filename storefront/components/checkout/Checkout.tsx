'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, isApiError } from '@/lib/api/client';
import {
  type AddressForm,
  addressReady,
  deliveryPrice,
  emptyAddress,
  expectedTotal,
  idError,
  newIdempotencyKey,
  orderAddress,
  PAYMENT_METHODS,
  quoteAddress,
  savePendingPayment,
} from '@/lib/checkout';
import type { Address, CheckoutResult, DeliveryQuote, PaymentMethod } from '@/lib/commerce-types';
import { formatMoney, formatSlot } from '@/lib/format';
import { CartLines } from '../cart/CartLines';
import { useAuth } from '../providers/AuthProvider';
import { useCart } from '../providers/CartProvider';
import { useToast } from '../providers/ToastProvider';
import { AddressFields } from './AddressFields';

type IdType = '04' | '05' | '06';

/**
 * Checkout en una sola página: contacto (invitado o cliente), dirección en el mapa, envío con
 * franja horaria, facturación, pago y confirmación. La cotización se pide al API con el punto del
 * mapa; el total final lo confirma el API (expectedTotal) para que no haya sorpresas.
 */
export function Checkout() {
  const { status, user } = useAuth();
  const { cart, loading, refresh } = useCart();
  const toast = useToast();
  const router = useRouter();

  const [contact, setContact] = useState({ name: '', email: '', phone: '' });
  const [saved, setSaved] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState<string | 'new'>('new');
  const [address, setAddress] = useState<AddressForm>(emptyAddress);
  const [saveAddress, setSaveAddress] = useState(true);
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [optionId, setOptionId] = useState<string | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [invoice, setInvoice] = useState({ wants: false, name: '', idType: '05' as IdType, idNumber: '' });
  const [method, setMethod] = useState<PaymentMethod>('card');
  const [notes, setNotes] = useState('');
  const [paying, setPaying] = useState(false);
  const [totalChanged, setTotalChanged] = useState<string | null>(null);
  const idemKey = useRef<string>(newIdempotencyKey());

  // Datos del cliente con sesión y sus direcciones guardadas.
  useEffect(() => {
    if (status !== 'authenticated' || !user) return;
    setContact((c) => ({
      name: c.name || [user.firstName, user.lastName].filter(Boolean).join(' '),
      email: user.email,
      phone: c.phone || user.phone || '',
    }));
    void api<Address[]>('/me/addresses')
      .then((list) => {
        setSaved(list);
        const def = list.find((a) => a.isDefault && a.location) ?? list.find((a) => a.location);
        if (def) setAddressId(def.id);
      })
      .catch(() => undefined);
  }, [status, user]);

  const usingSaved = addressId !== 'new' && status === 'authenticated';
  const canQuote = usingSaved || addressReady(address);

  // Cotiza cuando cambia la dirección (con una pausa, por si sigue moviendo el pin).
  const quoteKey = usingSaved ? `id:${addressId}` : canQuote ? JSON.stringify(quoteAddress(address)) : '';
  useEffect(() => {
    if (!quoteKey || !cart || cart.items.length === 0) {
      setQuote(null);
      return;
    }
    const t = setTimeout(async () => {
      setQuoting(true);
      setQuoteError(null);
      try {
        const body = usingSaved ? { addressId } : { shippingAddress: quoteAddress(address) };
        const q = await api<DeliveryQuote>('/checkout/delivery-options', { method: 'POST', body });
        setQuote(q);
        const first = q.options[0];
        setOptionId(first?.quoteId ?? null);
        setSlotId(first?.slots?.find((s) => s.available > 0)?.slotId ?? null);
        if (q.options.length === 0) setQuoteError('No llegamos a esa dirección todavía. Prueba con otra o contáctanos.');
      } catch (e) {
        setQuote(null);
        setQuoteError(isApiError(e, 'ADDRESS_NEEDS_PIN') ? 'Esa dirección guardada no tiene ubicación: márcala en el mapa.' : errorMessage(e));
      } finally {
        setQuoting(false);
      }
    }, 600);
    return () => clearTimeout(t);
    // address y addressId ya están resumidos en quoteKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, cart?.totals.total]);

  const option = quote?.options.find((o) => o.quoteId === optionId);
  const shipping = deliveryPrice(option, slotId);
  const total = cart ? expectedTotal(cart.totals.total, shipping, cart.freeShipping) : null;
  const methods = PAYMENT_METHODS.filter((m) => !m.riderOnly || option?.type === 'rider');
  useEffect(() => {
    if (!methods.some((m) => m.value === method)) setMethod('card');
  }, [methods, method]);

  const invoiceProblem = invoice.wants ? idError(invoice.idType, invoice.idNumber.trim()) : null;
  const contactOk = contact.name.trim().length >= 2 && /^\S+@\S+\.\S+$/.test(contact.email.trim()) && /^\+?\d{7,15}$/.test(contact.phone.replace(/[\s-]/g, ''));
  const ready = !!cart?.canCheckout && contactOk && !!option && (option.type !== 'rider' || !option.slots?.length || !!slotId) && !invoiceProblem && !!total;

  const chosenSlot = option?.slots?.find((s) => s.slotId === slotId);
  const summary = !option ? null : chosenSlot ? `${option.label} · ${formatSlot(chosenSlot.startsAt, chosenSlot.endsAt)}` : option.label;

  async function pay(confirmTotal?: string) {
    if (!cart || !option || !total) return;
    setPaying(true);
    setTotalChanged(null);
    try {
      // Cliente con dirección nueva: se guarda para la próxima compra (con el pin exacto).
      if (status === 'authenticated' && !usingSaved && saveAddress) {
        await api('/me/addresses', {
          method: 'POST',
          body: {
            recipientName: contact.name.trim(),
            recipientPhone: contact.phone.replace(/[\s-]/g, ''),
            province: address.province,
            city: address.city.trim(),
            mainStreet: address.mainStreet.trim(),
            ...(address.secondaryStreet.trim() ? { crossStreet: address.secondaryStreet.trim() } : {}),
            ...(address.number.trim() ? { houseNumber: address.number.trim() } : {}),
            ...(address.reference.trim() ? { reference: address.reference.trim() } : {}),
            ...(address.neighborhood.trim() ? { neighborhood: address.neighborhood.trim() } : {}),
            pin: { lat: address.lat, lng: address.lng },
          },
        }).catch(() => undefined);
      }
      const phone = contact.phone.replace(/[\s-]/g, '');
      const body = {
        customer: { name: contact.name.trim(), email: contact.email.trim(), phone, ...(invoice.wants ? { idType: invoice.idType, idNumber: invoice.idNumber.trim() } : {}) },
        ...(invoice.wants ? { billing: { name: (invoice.name || contact.name).trim(), idType: invoice.idType, idNumber: invoice.idNumber.trim(), email: contact.email.trim() } } : {}),
        fulfillmentType: option.type,
        ...(usingSaved ? { addressId } : { shippingAddress: orderAddress(address) }),
        deliveryQuoteId: option.quoteId,
        ...(option.type === 'rider' && slotId ? { deliverySlotId: slotId } : {}),
        paymentMethod: method,
        expectedTotal: confirmTotal ?? total,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        channel: 'web' as const,
      };
      const result = await api<CheckoutResult>('/checkout', { method: 'POST', body, headers: { 'Idempotency-Key': idemKey.current } });
      savePendingPayment({
        paymentId: result.payment.payment.id,
        clientSecret: result.payment.clientSecret,
        orderId: result.orderId,
        orderNumber: result.orderNumber,
        trackingToken: result.delivery.trackingToken,
        total: result.totals.total,
      });
      void refresh();
      const next = result.payment.nextAction;
      if (next.type === 'redirect') {
        window.location.assign(next.url);
        return;
      }
      router.push(`/checkout/resultado?paymentId=${result.payment.payment.id}`);
    } catch (e) {
      // Cada intento fallido usa una clave nueva: el siguiente es otro intento, no un reintento.
      idemKey.current = newIdempotencyKey();
      if (isApiError(e, 'CHECKOUT_TOTAL_CHANGED')) {
        setTotalChanged(String(e.details.actual ?? ''));
      } else if (isApiError(e, 'DELIVERY_QUOTE_EXPIRED') || isApiError(e, 'SLOT_UNAVAILABLE')) {
        toast('La franja o la tarifa ya no están disponibles. Elige otra.', 'error');
        setQuote(null);
      } else {
        toast(errorMessage(e), 'error');
      }
      setPaying(false);
    }
  }

  if (loading) return <div className="container-page py-16 text-ink-soft">Cargando…</div>;
  if (!cart || cart.items.length === 0) {
    return (
      <div className="container-page py-20 text-center">
        <h1 className="text-3xl">No hay nada que pagar</h1>
        <Link href="/tienda" className="btn-primary mt-6">
          Ir a la tienda
        </Link>
      </div>
    );
  }

  return (
    <div className="container-page grid gap-10 py-10 lg:grid-cols-[1fr_400px]">
      <div className="space-y-10">
        <h1 className="text-3xl">Finalizar compra</h1>

        <Step n={1} title="Tus datos">
          {status === 'guest' && (
            <p className="mb-4 rounded-lg bg-sand px-4 py-3 text-sm">
              Compras como invitado.{' '}
              <Link href="/ingresar?volver=/checkout" className="underline">
                Ingresa
              </Link>{' '}
              para usar tus direcciones guardadas y seguir tus pedidos.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nombre y apellido" id="c-name">
              <input id="c-name" autoComplete="name" className="input" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} required />
            </Field>
            <Field label="Celular" id="c-phone">
              <input id="c-phone" type="tel" autoComplete="tel" className="input" placeholder="0991234567" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} required />
            </Field>
            <Field label="Correo (te enviamos la factura y el seguimiento)" id="c-email" wide>
              <input id="c-email" type="email" autoComplete="email" className="input" value={contact.email} readOnly={status === 'authenticated'} onChange={(e) => setContact({ ...contact, email: e.target.value })} required />
            </Field>
          </div>
        </Step>

        <Step n={2} title="¿Dónde lo entregamos?">
          {status === 'authenticated' && saved.length > 0 && (
            <fieldset className="mb-4 space-y-2">
              <legend className="sr-only">Direcciones guardadas</legend>
              {saved.map((a) => (
                <label key={a.id} className={`card flex cursor-pointer gap-3 p-3 ${addressId === a.id ? 'border-ink' : ''}`}>
                  <input type="radio" name="addr" className="mt-1 accent-ink" checked={addressId === a.id} onChange={() => setAddressId(a.id)} disabled={!a.location} />
                  <span className="text-sm">
                    <span className="font-medium">{a.label ?? a.mainStreet}</span>
                    <span className="block text-ink-soft">
                      {[a.mainStreet, a.crossStreet].filter(Boolean).join(' y ')} {a.houseNumber} · {a.city}
                    </span>
                    {!a.location && <span className="text-xs text-danger">Sin ubicación: edítala en Mi cuenta → Direcciones</span>}
                  </span>
                </label>
              ))}
              <label className={`card flex cursor-pointer gap-3 p-3 ${addressId === 'new' ? 'border-ink' : ''}`}>
                <input type="radio" name="addr" className="accent-ink" checked={addressId === 'new'} onChange={() => setAddressId('new')} />
                <span className="text-sm font-medium">Otra dirección</span>
              </label>
            </fieldset>
          )}
          {!usingSaved && (
            <>
              <AddressFields value={address} onChange={setAddress} geocode={status === 'authenticated'} />
              {status === 'authenticated' && (
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-ink" checked={saveAddress} onChange={(e) => setSaveAddress(e.target.checked)} />
                  Guardar esta dirección
                </label>
              )}
            </>
          )}
        </Step>

        <Step n={3} title="Envío y franja horaria">
          {!canQuote && <p className="text-sm text-ink-soft">Completa la dirección y marca tu puerta en el mapa para ver las opciones.</p>}
          {quoting && <p className="text-sm text-ink-soft">Calculando opciones de envío…</p>}
          {quoteError && <p className="text-sm text-danger">{quoteError}</p>}
          {quote && !quoting && quote.options.length > 0 && (
            <div className="space-y-4">
              {quote.zone && <p className="text-xs text-ink-soft">Zona: {quote.zone.name}</p>}
              <fieldset className="space-y-2">
                <legend className="sr-only">Forma de envío</legend>
                {quote.options.map((o) => (
                  <label key={o.quoteId} className={`card flex cursor-pointer items-start gap-3 p-4 ${optionId === o.quoteId ? 'border-ink' : ''}`}>
                    <input
                      type="radio"
                      name="ship"
                      className="mt-1 accent-ink"
                      checked={optionId === o.quoteId}
                      onChange={() => {
                        setOptionId(o.quoteId);
                        setSlotId(o.slots?.find((s) => s.available > 0)?.slotId ?? null);
                      }}
                    />
                    <span className="flex-1 text-sm">
                      <span className="font-medium">{o.type === 'rider' ? '🛵 ' : '📦 '}{o.label}</span>
                      <span className="block text-ink-soft">
                        {o.type === 'rider' ? 'Síguelo en vivo en el mapa' : o.etaHours ? `Llega en ~${Math.ceil(o.etaHours / 24)} día(s) hábil(es)` : 'Courier a domicilio'}
                        {o.distanceKm ? ` · ${o.distanceKm.toFixed(1)} km` : ''}
                      </span>
                    </span>
                    <span className="font-semibold">{cart.freeShipping ? 'Gratis' : `desde ${formatMoney(o.price)}`}</span>
                  </label>
                ))}
              </fieldset>
              {option?.type === 'rider' && option.slots && option.slots.length > 0 && (
                <fieldset>
                  <legend className="label">Elige la franja de entrega</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {option.slots.map((s) => (
                      <label
                        key={s.slotId}
                        className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-sm ${s.available === 0 ? 'cursor-not-allowed opacity-40' : slotId === s.slotId ? 'border-ink bg-ink text-paper' : 'border-line bg-white'}`}
                      >
                        <input type="radio" name="slot" className="sr-only" disabled={s.available === 0} checked={slotId === s.slotId} onChange={() => setSlotId(s.slotId)} />
                        <span>{formatSlot(s.startsAt, s.endsAt)}</span>
                        <span>{s.available === 0 ? 'Lleno' : cart.freeShipping ? 'Gratis' : formatMoney(s.price)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </div>
          )}
        </Step>

        <Step n={4} title="Factura">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-ink" checked={!invoice.wants} onChange={(e) => setInvoice({ ...invoice, wants: !e.target.checked })} />
            Consumidor final (sin datos)
          </label>
          {invoice.wants && (
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Tipo" id="i-type">
                <select id="i-type" className="input" value={invoice.idType} onChange={(e) => setInvoice({ ...invoice, idType: e.target.value as IdType })}>
                  <option value="05">Cédula</option>
                  <option value="04">RUC</option>
                  <option value="06">Pasaporte</option>
                </select>
              </Field>
              <Field label="Número" id="i-num">
                <input id="i-num" className="input" inputMode={invoice.idType === '06' ? 'text' : 'numeric'} value={invoice.idNumber} onChange={(e) => setInvoice({ ...invoice, idNumber: e.target.value })} aria-invalid={!!invoiceProblem && invoice.idNumber.length > 0} />
              </Field>
              <Field label="Razón social (opcional)" id="i-name">
                <input id="i-name" className="input" placeholder={contact.name} value={invoice.name} onChange={(e) => setInvoice({ ...invoice, name: e.target.value })} />
              </Field>
              {invoiceProblem && invoice.idNumber.length > 0 && <p className="text-xs text-danger sm:col-span-3">{invoiceProblem}</p>}
            </div>
          )}
          <p className="mt-2 text-xs text-ink-soft">Factura electrónica autorizada por el SRI (ambiente de pruebas). Te llega por correo.</p>
        </Step>

        <Step n={5} title="Pago">
          <fieldset className="space-y-2">
            <legend className="sr-only">Método de pago</legend>
            {methods.map((m) => (
              <label key={m.value} className={`card flex cursor-pointer gap-3 p-4 ${method === m.value ? 'border-ink' : ''}`}>
                <input type="radio" name="pay" className="mt-1 accent-ink" checked={method === m.value} onChange={() => setMethod(m.value)} />
                <span className="text-sm">
                  <span className="font-medium">{m.label}</span>
                  <span className="block text-ink-soft">{m.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="mt-4">
            <label className="label" htmlFor="notes">
              Indicaciones para la entrega (opcional)
            </label>
            <textarea id="notes" className="input" maxLength={500} placeholder="Ej.: dejar con el guardia" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </Step>
      </div>

      <aside className="h-fit space-y-4 lg:sticky lg:top-28">
        <div className="card p-5">
          <h2 className="text-lg">Tu pedido</h2>
          <div className="max-h-72 overflow-y-auto">
            <CartLines compact />
          </div>
          <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
            <div className="flex justify-between">
              <dt>Productos (IVA incluido)</dt>
              <dd>{formatMoney(cart.totals.total)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Envío</dt>
              <dd>{cart.freeShipping ? 'Gratis' : shipping ? formatMoney(shipping) : '—'}</dd>
            </div>
            {summary && <p className="text-xs text-ink-soft">{summary}</p>}
            <div className="flex justify-between border-t border-line pt-2 text-lg font-semibold">
              <dt>Total</dt>
              <dd>{total ? formatMoney(total) : '—'}</dd>
            </div>
          </dl>
          {totalChanged && (
            <div role="alert" className="mt-3 rounded-lg bg-warn/10 p-3 text-sm">
              El total se actualizó a <strong>{formatMoney(totalChanged)}</strong> (cambió un precio o una promoción).
              <button type="button" className="btn-primary mt-2 w-full" onClick={() => void pay(totalChanged)} disabled={paying}>
                Pagar {formatMoney(totalChanged)}
              </button>
            </div>
          )}
          <button type="button" className="btn-accent mt-4 w-full py-3 text-base" disabled={!ready || paying} onClick={() => void pay()}>
            {paying ? 'Procesando…' : method === 'cod' ? 'Confirmar pedido' : `Pagar ${total ? formatMoney(total) : ''}`}
          </button>
          {!contactOk && <p className="mt-2 text-xs text-ink-soft">Completa tus datos de contacto.</p>}
          <p className="mt-3 text-xs text-ink-soft">Pasarela de pago simulada: no se realizan cobros reales.</p>
        </div>
      </aside>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`step-${n}`}>
      <h2 id={`step-${n}`} className="mb-4 flex items-center gap-3 text-xl">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink font-sans text-sm text-paper">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, id, wide, children }: { label: string; id: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}
