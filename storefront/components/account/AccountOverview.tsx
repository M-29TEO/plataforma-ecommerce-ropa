'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api/client';
import type { OrderSummary } from '@/lib/commerce-types';
import { formatDate, formatMoney } from '@/lib/format';
import { currentPushState, subscribePush, unsubscribePush } from '@/lib/push';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';
import { InstallAppButton } from '../pwa/InstallAppButton';
import { ORDER_STATUS_LABEL } from './order-status';

type PushState = Awaited<ReturnType<typeof currentPushState>>;

export function AccountOverview() {
  const { user } = useAuth();
  const toast = useToast();
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [push, setPush] = useState<PushState>('unavailable');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<OrderSummary[]>('/me/orders?limit=3').then(setOrders).catch(() => setOrders([]));
    void currentPushState().then(setPush);
  }, []);

  async function togglePush() {
    setBusy(true);
    try {
      if (push === 'subscribed') {
        await unsubscribePush();
        setPush('not_subscribed');
        toast('Ya no recibirás avisos en este dispositivo');
      } else {
        const r = await subscribePush();
        if (r === 'subscribed') toast('¡Listo! Te avisaremos cada paso de tu pedido', 'ok');
        if (r === 'denied') toast('Bloqueaste las notificaciones en el navegador. Actívalas en la configuración del sitio.', 'error');
        setPush(await currentPushState());
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="card p-6">
        <h1 className="text-2xl">Mi cuenta</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {user?.firstName} {user?.lastName} · {user?.email}
        </p>
      </div>

      <div className="card p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-sans text-base font-semibold">Avisos en este dispositivo</h2>
            <p className="text-sm text-ink-soft">
              {push === 'unavailable'
                ? 'Este navegador no admite notificaciones push (en iPhone, instala la app primero).'
                : push === 'denied'
                  ? 'Las notificaciones están bloqueadas en el navegador.'
                  : 'Recibe un aviso cuando tu pedido se confirme, salga de bodega y esté por llegar.'}
            </p>
          </div>
          {(push === 'subscribed' || push === 'not_subscribed') && (
            <button type="button" className={push === 'subscribed' ? 'btn-ghost' : 'btn-primary'} onClick={togglePush} disabled={busy}>
              {push === 'subscribed' ? 'Desactivar avisos' : 'Activar avisos'}
            </button>
          )}
        </div>
        <div className="mt-4">
          <InstallAppButton />
        </div>
      </div>

      <div>
        <div className="flex items-end justify-between">
          <h2 className="text-xl">Pedidos recientes</h2>
          <Link href="/mi-cuenta/pedidos" className="text-sm underline">
            Ver todos
          </Link>
        </div>
        {orders === null ? (
          <p className="mt-3 text-sm text-ink-soft">Cargando…</p>
        ) : orders.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">
            Aún no tienes pedidos.{' '}
            <Link href="/tienda" className="underline">
              Empieza a comprar
            </Link>
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-white">
            {orders.map((o) => (
              <li key={o.id}>
                <Link href={`/mi-cuenta/pedidos/${o.id}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-sand/50">
                  <span>
                    <span className="font-medium">Pedido #{o.orderNumber}</span>
                    <span className="block text-xs text-ink-soft">{formatDate(o.placedAt)}</span>
                  </span>
                  <span className="text-sm">{ORDER_STATUS_LABEL[o.status]}</span>
                  <span className="font-medium">{formatMoney(o.total)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
