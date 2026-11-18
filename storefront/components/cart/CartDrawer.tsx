'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useCart } from '../providers/CartProvider';
import { CartLines, CartTotals } from './CartLines';

export function CartDrawer() {
  const { open, setOpen, cart, count } = useCart();
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname, setOpen]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-ink/40" onClick={() => setOpen(false)} role="presentation">
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Tu carrito"
        className="ml-auto flex h-full w-full max-w-md flex-col bg-paper shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-lg">Tu carrito ({count})</h2>
          <button type="button" onClick={() => setOpen(false)} aria-label="Cerrar carrito" className="text-xl">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5">
          {cart && cart.items.length > 0 ? (
            <CartLines compact />
          ) : (
            <div className="py-16 text-center">
              <p className="text-ink-soft">Tu carrito está vacío.</p>
              <Link href="/tienda" className="btn-primary mt-4">
                Ver la tienda
              </Link>
            </div>
          )}
        </div>
        {cart && cart.items.length > 0 && (
          <div className="space-y-3 border-t border-line px-5 py-4">
            <CartTotals />
            <div className="grid grid-cols-2 gap-2">
              <Link href="/carrito" className="btn-ghost">
                Ver carrito
              </Link>
              <Link href="/checkout" className={`btn-accent ${cart.canCheckout ? '' : 'pointer-events-none opacity-50'}`} aria-disabled={!cart.canCheckout}>
                Pagar
              </Link>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
