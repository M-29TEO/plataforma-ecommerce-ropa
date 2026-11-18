'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api/client';
import type { OrderSummary } from '@/lib/commerce-types';
import { formatDate, formatMoney } from '@/lib/format';
import { ORDER_STATUS_LABEL, PAYMENT_METHOD_LABEL } from './order-status';

const PAGE = 10;

/** El API no devuelve total: se pide una página y "ver más" si llegó completa. */
export function OrdersList() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(offset: number) {
    setLoading(true);
    try {
      const page = await api<OrderSummary[]>(`/me/orders?limit=${PAGE}&offset=${offset}`);
      setOrders((o) => (offset === 0 ? page : [...o, ...page]));
      setDone(page.length < PAGE);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(0);
  }, []);

  return (
    <div>
      <h1 className="text-3xl">Mis pedidos</h1>
      {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      {!loading && orders.length === 0 && !error && (
        <p className="mt-4 text-ink-soft">
          Todavía no tienes pedidos.{' '}
          <Link href="/tienda" className="underline">
            Ir a la tienda
          </Link>
        </p>
      )}
      <ul className="mt-6 space-y-3">
        {orders.map((o) => (
          <li key={o.id}>
            <Link href={`/mi-cuenta/pedidos/${o.id}`} className="card flex flex-wrap items-center justify-between gap-3 p-4 hover:border-ink">
              <div>
                <p className="font-medium">Pedido #{o.orderNumber}</p>
                <p className="text-xs text-ink-soft">
                  {formatDate(o.placedAt)} · {o.itemCount} {o.itemCount === 1 ? 'artículo' : 'artículos'} · {PAYMENT_METHOD_LABEL[o.paymentMethod] ?? o.paymentMethod}
                </p>
              </div>
              <span className={`chip ${o.status === 'cancelled' ? 'text-danger' : o.status === 'delivered' ? 'text-ok' : ''}`}>{ORDER_STATUS_LABEL[o.status]}</span>
              <span className="font-semibold">{formatMoney(o.total)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {!done && orders.length > 0 && (
        <button type="button" className="btn-ghost mt-4" disabled={loading} onClick={() => void load(orders.length)}>
          {loading ? 'Cargando…' : 'Ver más'}
        </button>
      )}
    </div>
  );
}
