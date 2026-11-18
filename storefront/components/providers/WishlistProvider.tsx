'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api/client';
import type { WishlistItem } from '@/lib/commerce-types';
import { useAuth } from './AuthProvider';

interface WishlistContextValue {
  items: WishlistItem[];
  has(productId: string): boolean;
  /** Agrega o quita. Sin sesión devuelve false (la UI pide iniciar sesión). */
  toggle(productId: string): Promise<boolean>;
  update(productId: string, patch: { notifyBackInStock?: boolean; notifyPriceDrop?: boolean }): Promise<void>;
  refresh(): Promise<void>;
}

const WishlistContext = createContext<WishlistContextValue | null>(null);

export function WishlistProvider({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const [items, setItems] = useState<WishlistItem[]>([]);

  const refresh = useCallback(async () => {
    if (status !== 'authenticated') {
      setItems([]);
      return;
    }
    setItems(await api<WishlistItem[]>('/me/wishlist'));
  }, [status]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const value = useMemo<WishlistContextValue>(
    () => ({
      items,
      has: (id) => items.some((i) => i.productId === id),
      async toggle(productId) {
        if (status !== 'authenticated') return false;
        if (items.some((i) => i.productId === productId)) {
          await api(`/me/wishlist/${productId}`, { method: 'DELETE' });
          setItems((list) => list.filter((i) => i.productId !== productId));
        } else {
          const added = await api<WishlistItem>('/me/wishlist', { method: 'POST', body: { productId, notifyBackInStock: true, notifyPriceDrop: true } });
          setItems((list) => [added, ...list.filter((i) => i.productId !== productId)]);
        }
        return true;
      },
      async update(productId, patch) {
        const updated = await api<WishlistItem>(`/me/wishlist/${productId}`, { method: 'PATCH', body: patch });
        setItems((list) => list.map((i) => (i.productId === productId ? updated : i)));
      },
      refresh,
    }),
    [items, status, refresh],
  );

  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}

export function useWishlist(): WishlistContextValue {
  const ctx = useContext(WishlistContext);
  if (!ctx) throw new Error('useWishlist fuera de <WishlistProvider>');
  return ctx;
}
