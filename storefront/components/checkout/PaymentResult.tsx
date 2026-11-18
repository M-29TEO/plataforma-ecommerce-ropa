'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api/client';
import { loadPendingPayment, type PendingPayment } from '@/lib/checkout';
import type { PaymentCreated } from '@/lib/commerce-types';
import { formatDate, formatMoney } from '@/lib/format';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';

const FINAL = new Set(['captured', 'authorized', 'failed', 'cancelled', 'expired', 'refunded', 'partially_refunded']);
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Resultado del pago. El estado se consulta con GET /payments/:id/public y el secreto del pago
 * (guardado en sessionStorage antes de ir a la pasarela): el id solo, en la URL, no basta para verlo.
 * El webhook de la pasarela puede llegar unos segundos después: se consulta cada 2 s hasta 1 min.
 * Sin el secreto (p. ej. un pedido asistido pagado con el enlace que envió el vendedor) solo se
 * explica que el pago se está confirmando y dónde ver su estado.
 */
export function PaymentResult() {
  const paymentId = useSearchParams().get('paymentId') ?? '';
  const { status: auth } = useAuth();
  const toast = useToast();
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [data, setData] = useState<PaymentCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voucherSent, setVoucherSent] = useState(false);

  useEffect(() => {
    if (!UUID.test(paymentId)) {
      setError('El enlace del pago no es válido.');
      return;
    }
    const p = loadPendingPayment(paymentId);
    setPending(p);
    if (!p) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await api<PaymentCreated>(`/payments/${paymentId}/public`, { headers: { 'X-Payment-Secret': p.clientSecret } });
        setData(res);
        const waitingWebhook = !FINAL.has(res.payment.status) && res.nextAction.type === 'redirect';
        if (waitingWebhook && ++tries < 30) timer = setTimeout(poll, 2000);
      } catch (e) {
        setError(errorMessage(e));
      }
    };
    void poll();
    return () => clearTimeout(timer);
  }, [paymentId]);

  async function sendVoucher(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!pending) return;
    const form = new FormData(e.currentTarget);
    try {
      await api(`/payments/${paymentId}/transfer/voucher`, { method: 'POST', form, headers: { 'X-Payment-Secret': pending.clientSecret } });
      setVoucherSent(true);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  if (error) return <Shell title="No pudimos mostrar el pago" tone="danger" text={error} />;
  if (!pending) {
    // Sin el secreto del pago (enlace de pago que mandó un vendedor, otra ventana u otro dispositivo):
    // el estado no se puede consultar. La pasarela vuelve solo con ?paymentId, sin parámetros
    // firmados, así que no se muestra nada del pago; el webhook lo confirma igual en el backend.
    return (
      <Shell
        title="Estamos confirmando tu pago"
        text="Estamos confirmando tu pago; te avisaremos por correo y puedes ver el estado en Mis pedidos o con el enlace de seguimiento."
      >
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href={auth === 'authenticated' ? '/mi-cuenta/pedidos' : '/ingresar?volver=/mi-cuenta/pedidos'} className="btn-accent">
            Mis pedidos
          </Link>
          <Link href="/" className="btn-ghost">
            Seguir comprando
          </Link>
        </div>
      </Shell>
    );
  }
  if (!data) return <Shell title="Confirmando tu pago…" text="Esto toma unos segundos." />;

  const { payment, nextAction } = data;
  const tracking = pending.trackingToken ? (
    <Link href={`/seguimiento/${pending.trackingToken}`} className="btn-accent">
      Seguir mi pedido
    </Link>
  ) : null;
  const orders = auth === 'authenticated' ? (
    <Link href={`/mi-cuenta/pedidos/${pending.orderId}`} className="btn-ghost">
      Ver el pedido
    </Link>
  ) : null;

  if (payment.status === 'captured' || payment.status === 'authorized') {
    return (
      <Shell title="¡Pago confirmado!" tone="ok" text={`Pedido #${pending.orderNumber} por ${formatMoney(payment.amount)}. Te enviamos la confirmación y la factura por correo.`}>
        {payment.cardLast4 && <p className="text-sm text-ink-soft">Tarjeta {payment.cardBrand} terminada en {payment.cardLast4}</p>}
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {tracking}
          {orders}
        </div>
      </Shell>
    );
  }

  if (nextAction.type === 'cash_on_delivery') {
    return (
      <Shell title="¡Pedido confirmado!" tone="ok" text={`Pedido #${pending.orderNumber}. Pagas ${formatMoney(pending.total)} en efectivo al recibirlo.`}>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {tracking}
          {orders}
        </div>
      </Shell>
    );
  }

  if (nextAction.type === 'bank_transfer') {
    return (
      <Shell title="Falta tu transferencia" text={`Pedido #${pending.orderNumber}. Transfiere ${formatMoney(payment.amount)} y sube el comprobante.`}>
        <dl className="card mx-auto mt-6 max-w-md space-y-2 p-5 text-left text-sm">
          <div>
            <dt className="text-ink-soft">Cuenta</dt>
            <dd className="font-medium">{nextAction.account}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">Referencia (escríbela en el concepto)</dt>
            <dd className="font-mono text-base font-semibold">{nextAction.reference}</dd>
          </div>
          {nextAction.expiresAt && (
            <div>
              <dt className="text-ink-soft">Plazo</dt>
              <dd>{formatDate(nextAction.expiresAt, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
            </div>
          )}
        </dl>
        {voucherSent ? (
          <p className="mt-6 text-ok">Recibimos tu comprobante. Te avisaremos cuando lo verifiquemos.</p>
        ) : (
          <form onSubmit={sendVoucher} className="card mx-auto mt-6 max-w-md space-y-3 p-5 text-left">
            <div>
              <label className="label" htmlFor="bank">
                Banco desde el que transferiste
              </label>
              <input id="bank" name="bankName" required minLength={2} maxLength={80} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="ref">
                Número de comprobante (opcional)
              </label>
              <input id="ref" name="reference" maxLength={80} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="voucher">
                Foto o PDF del comprobante (máx. 5 MB)
              </label>
              <input id="voucher" name="voucher" type="file" required accept="image/jpeg,image/png,image/webp,application/pdf" className="text-sm" />
            </div>
            <button className="btn-primary w-full">Enviar comprobante</button>
          </form>
        )}
      </Shell>
    );
  }

  if (FINAL.has(payment.status)) {
    return (
      <Shell tone="danger" title="El pago no se completó" text={payment.failureMessage ?? 'La pasarela rechazó el pago. No se cobró nada.'}>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {nextAction.type === 'redirect' && (
            <a href={nextAction.url} className="btn-accent">
              Intentar de nuevo
            </a>
          )}
          <Link href="/carrito" className="btn-ghost">
            Volver al carrito
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Tu pago está pendiente" text="Si ya pagaste, la confirmación llegará en unos segundos. Si cerraste la pasarela, puedes volver a abrirla.">
      {nextAction.type === 'redirect' && (
        <a href={nextAction.url} className="btn-accent mt-6">
          Ir a pagar
        </a>
      )}
    </Shell>
  );
}

function Shell({ title, text, tone, children }: { title: string; text: string; tone?: 'ok' | 'danger'; children?: React.ReactNode }) {
  return (
    <div className="container-page max-w-2xl py-20 text-center" role="status">
      <div className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full text-2xl ${tone === 'ok' ? 'bg-ok/15 text-ok' : tone === 'danger' ? 'bg-danger/15 text-danger' : 'bg-sand'}`} aria-hidden>
        {tone === 'ok' ? '✓' : tone === 'danger' ? '!' : '…'}
      </div>
      <h1 className="text-3xl">{title}</h1>
      <p className="mt-3 text-ink-soft">{text}</p>
      {children}
    </div>
  );
}
