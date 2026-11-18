'use client';

import Link from 'next/link';
import { useState } from 'react';
import { errorMessage } from '@/lib/api/client';
import { useCart } from '../providers/CartProvider';
import { useToast } from '../providers/ToastProvider';
import { CartLines, CartTotals } from './CartLines';

export function CartPage() {
  const { cart, loading, applyCoupon, removeCoupon, acknowledgePrices } = useCart();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function onCoupon(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    try {
      await applyCoupon(code.trim().toUpperCase());
      setCode('');
      toast('Cupón aplicado', 'ok');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="container-page py-16 text-ink-soft">Cargando tu carrito…</div>;

  if (!cart || cart.items.length === 0) {
    return (
      <div className="container-page py-20 text-center">
        <h1 className="text-3xl">Tu carrito está vacío</h1>
        <p className="mt-2 text-ink-soft">Explora las novedades y agrega lo que te guste.</p>
        <Link href="/tienda" className="btn-primary mt-6">
          Ir a la tienda
        </Link>
      </div>
    );
  }

  return (
    <div className="container-page grid gap-10 py-10 lg:grid-cols-[1fr_380px]">
      <section>
        <h1 className="text-3xl">Carrito</h1>
        {cart.hasPriceChanges && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn/40 bg-warn/10 p-4 text-sm">
            <span>Algunos precios cambiaron desde que agregaste los productos.</span>
            <button type="button" className="btn-ghost" onClick={() => void acknowledgePrices().catch((e) => toast(errorMessage(e), 'error'))}>
              Entendido
            </button>
          </div>
        )}
        <CartLines />
      </section>
      <aside className="card h-fit space-y-5 p-5 lg:sticky lg:top-28">
        <form onSubmit={onCoupon} className="flex gap-2">
          <label htmlFor="coupon" className="sr-only">
            Cupón
          </label>
          <input id="coupon" className="input" placeholder="Código de cupón" value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} />
          <button className="btn-ghost" disabled={busy}>
            Aplicar
          </button>
        </form>
        {cart.coupons.length > 0 && (
          <ul className="space-y-1 text-sm">
            {cart.coupons.map((c) => (
              <li key={c.code} className="flex items-center justify-between gap-2">
                <span className={c.applied ? 'text-ok' : 'text-danger'}>
                  {c.code} {c.applied ? '✓' : `· ${c.message ?? 'no aplica'}`}
                </span>
                <button type="button" className="text-xs underline" onClick={() => void removeCoupon(c.code).catch((e) => toast(errorMessage(e), 'error'))}>
                  Quitar
                </button>
              </li>
            ))}
          </ul>
        )}
        {cart.promotions.length > 0 && (
          <ul className="space-y-1 text-xs text-ok">
            {cart.promotions.map((p) => (
              <li key={p.promotionId}>✓ {p.name}</li>
            ))}
          </ul>
        )}
        <CartTotals />
        <Link href="/checkout" className={`btn-accent w-full ${cart.canCheckout ? '' : 'pointer-events-none opacity-50'}`} aria-disabled={!cart.canCheckout}>
          Continuar al pago
        </Link>
        {!cart.canCheckout && <p className="text-xs text-danger">Revisa los productos marcados antes de continuar.</p>}
        <p className="text-xs text-ink-soft">Puedes comprar como invitado o con tu cuenta.</p>
      </aside>
    </div>
  );
}
