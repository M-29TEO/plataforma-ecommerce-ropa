'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api/client';
import type { CartView, ProductThumb } from '@/lib/commerce-types';
import { useAuth } from './AuthProvider';

interface CartContextValue {
  cart: CartView | null;
  loading: boolean;
  /** Foto y slug por productId (el carrito no los guarda). */
  thumbs: Record<string, ProductThumb>;
  count: number;
  open: boolean;
  setOpen(open: boolean): void;
  refresh(): Promise<void>;
  add(variantId: string, quantity?: number): Promise<void>;
  update(variantId: string, quantity: number): Promise<void>;
  remove(variantId: string): Promise<void>;
  applyCoupon(code: string): Promise<void>;
  removeCoupon(code: string): Promise<void>;
  acknowledgePrices(): Promise<void>;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const [cart, setCart] = useState<CartView | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, ProductThumb>>({});
  const known = useRef(new Set<string>());

  const loadThumbs = useCallback(async (view: CartView) => {
    const missing = [...new Set(view.items.map((i) => i.productId).filter((id): id is string => !!id && !known.current.has(id)))];
    if (missing.length === 0) return;
    missing.forEach((id) => known.current.add(id));
    try {
      const list = await api<ProductThumb[]>(`/catalog/product-thumbs?ids=${missing.join(',')}`);
      setThumbs((prev) => ({ ...prev, ...Object.fromEntries(list.map((t) => [t.id, t])) }));
    } catch {
      missing.forEach((id) => known.current.delete(id));
    }
  }, []);

  const apply = useCallback(
    (view: CartView) => {
      setCart(view);
      void loadThumbs(view);
    },
    [loadThumbs],
  );

  const refresh = useCallback(async () => {
    try {
      apply(await api<CartView>('/cart'));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  // Al iniciar o cerrar sesión cambia el carrito (el de invitado se fusiona en el del cliente).
  useEffect(() => {
    if (status === 'loading') return;
    void refresh().catch(() => undefined);
  }, [status, refresh]);

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      loading,
      thumbs,
      count: cart?.totals.itemCount ?? 0,
      open,
      setOpen,
      refresh,
      async add(variantId, quantity = 1) {
        apply(await api<CartView>('/cart/items', { method: 'POST', body: { variantId, quantity } }));
      },
      async update(variantId, quantity) {
        apply(await api<CartView>(`/cart/items/${variantId}`, { method: 'PATCH', body: { quantity } }));
      },
      async remove(variantId) {
        apply(await api<CartView>(`/cart/items/${variantId}`, { method: 'DELETE' }));
      },
      async applyCoupon(code) {
        apply(await api<CartView>('/cart/coupons', { method: 'POST', body: { code } }));
      },
      async removeCoupon(code) {
        apply(await api<CartView>(`/cart/coupons/${encodeURIComponent(code)}`, { method: 'DELETE' }));
      },
      async acknowledgePrices() {
        apply(await api<CartView>('/cart/acknowledge-prices', { method: 'POST' }));
      },
    }),
    [cart, loading, thumbs, open, refresh, apply],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart fuera de <CartProvider>');
  return ctx;
}
