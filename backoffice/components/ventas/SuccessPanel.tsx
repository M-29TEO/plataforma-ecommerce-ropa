'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useToast } from '@/components/providers/ToastProvider';
import { paymentMessage, whatsappUrl, type AssistedOrderResult } from '@/lib/assisted';
import { formatDateTime, formatMoney } from '@/lib/format';
import { VoucherUploadModal } from './VoucherUploadModal';

/** URL pública de seguimiento en la tienda (mismo dominio, fuera de /admin). */
function trackingUrl(token: string | null | undefined): string | null {
  if (!token || typeof window === 'undefined') return null;
  return `${window.location.origin}/seguimiento/${encodeURIComponent(token)}`;
}

export function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error('No se pudo copiar: selecciona el texto y cópialo a mano.');
        }
      }}
    >
      {done ? 'Copiado' : label}
    </button>
  );
}

/** Pantalla de éxito: número, total, cómo paga el cliente (enlace / transferencia / contra entrega) y seguimiento. */
export function SuccessPanel({
  result,
  phone,
  name,
  onNew,
}: {
  result: AssistedOrderResult;
  phone: string | null;
  name: string;
  onNew: () => void;
}) {
  const p = result.payment;
  const tracking = trackingUrl(result.delivery?.trackingToken);
  const message = paymentMessage(result, { name, trackingUrl: tracking, money: formatMoney, dateTime: formatDateTime });
  const wa = whatsappUrl(phone, message);
  const [voucherOpen, setVoucherOpen] = useState(false);

  return (
    <div className="card mx-auto max-w-2xl space-y-5 p-5">
      <div>
        <p className="text-sm text-ok">Pedido creado</p>
        <h2 className="text-2xl font-semibold">{result.orderNumber}</h2>
        <p className="text-lg">{formatMoney(result.total)}</p>
      </div>

      {p.method === 'card_link' &&
        (p.paymentUrl ? (
          <section className="space-y-2">
            <h3 className="font-semibold">Enlace de pago con tarjeta</h3>
            <p className="rounded-md border border-line bg-sand/40 px-3 py-2 font-mono text-xs break-all">{p.paymentUrl}</p>
            {p.expiresAt && <p className="text-sm text-warn">Vence el {formatDateTime(p.expiresAt)}.</p>}
          </section>
        ) : (
          <p className="text-sm text-warn">La pasarela no devolvió el enlace de pago. Revisa el pedido.</p>
        ))}

      {p.method === 'transfer' && p.transfer && (
        <section className="space-y-2">
          <h3 className="font-semibold">Datos para la transferencia</h3>
          <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 text-sm">
            <dt className="text-ink-soft">Cuenta</dt>
            <dd className="font-mono break-all">{p.transfer.account}</dd>
            <dd>
              <CopyButton text={p.transfer.account} />
            </dd>
            <dt className="text-ink-soft">Referencia</dt>
            <dd className="font-mono break-all">{p.transfer.reference}</dd>
            <dd>
              <CopyButton text={p.transfer.reference} />
            </dd>
            <dt className="text-ink-soft">Monto</dt>
            <dd className="col-span-2">{formatMoney(p.amount)}</dd>
            {(p.transfer.expiresAt ?? p.expiresAt) && (
              <>
                <dt className="text-ink-soft">Vence</dt>
                <dd className="col-span-2 text-warn">{formatDateTime(p.transfer.expiresAt ?? p.expiresAt)}</dd>
              </>
            )}
          </dl>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setVoucherOpen(true)}>
            Subir comprobante
          </button>
          <VoucherUploadModal open={voucherOpen} orderId={result.orderId} orderNumber={result.orderNumber} onClose={() => setVoucherOpen(false)} />
        </section>
      )}

      {p.method === 'cod' && (
        <p className="rounded-md border border-info/30 bg-info/5 px-3 py-2 text-sm text-info">
          Pago contra entrega: el cliente paga {formatMoney(result.total)} al recibir. Recuérdale tener el monto listo.
        </p>
      )}

      {tracking && (
        <section className="space-y-1">
          <h3 className="font-semibold">Seguimiento</h3>
          <div className="flex flex-wrap items-center gap-2">
            <a href={tracking} target="_blank" rel="noreferrer" className="font-mono text-xs break-all underline">
              {tracking}
            </a>
            <CopyButton text={tracking} />
          </div>
        </section>
      )}

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <CopyButton text={message} label={p.method === 'card_link' ? 'Copiar mensaje con el enlace' : 'Copiar mensaje'} />
        {p.method === 'card_link' && p.paymentUrl && <CopyButton text={p.paymentUrl} label="Copiar enlace" />}
        <a href={wa} target="_blank" rel="noreferrer" className="btn-accent btn-sm">
          Enviar por WhatsApp
        </a>
        <Link href={`/pedidos/${result.orderId}`} className="btn-ghost btn-sm">
          Ver pedido
        </Link>
        <button type="button" className="btn-primary btn-sm ml-auto" onClick={onNew}>
          Nuevo pedido
        </button>
      </div>
      {!phone && <p className="text-xs text-ink-soft">El cliente no tiene teléfono válido: WhatsApp pedirá elegir el contacto.</p>}
    </div>
  );
}
