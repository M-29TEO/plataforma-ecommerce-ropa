'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api/client';
import type { ProductThumb } from '@/lib/commerce-types';
import { formatMoney } from '@/lib/format';
import { useToast } from '../providers/ToastProvider';
import { useWishlist } from '../providers/WishlistProvider';

/** Favoritos con alertas de precio y de reposición (las manda CRM por email/push). */
export function WishlistPage() {
  const { items, toggle, update } = useWishlist();
  const toast = useToast();
  const [thumbs, setThumbs] = useState<Record<string, ProductThumb>>({});

  const ids = items.map((i) => i.productId).join(',');
  useEffect(() => {
    if (!ids) return;
    void api<ProductThumb[]>(`/catalog/product-thumbs?ids=${ids}`)
      .then((list) => setThumbs(Object.fromEntries(list.map((t) => [t.id, t]))))
      .catch(() => undefined);
  }, [ids]);

  const safe = (fn: () => Promise<unknown>) => () => void fn().catch((e) => toast(errorMessage(e), 'error'));

  return (
    <div>
      <h1 className="text-3xl">Favoritos</h1>
      {items.length === 0 ? (
        <p className="mt-4 text-ink-soft">
          Toca el corazón en cualquier producto para guardarlo aquí.{' '}
          <Link href="/tienda" className="underline">
            Explorar la tienda
          </Link>
        </p>
      ) : (
        <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3">
          {items.map((i) => {
            const t = thumbs[i.productId];
            const href = i.slug ? `/producto/${i.slug}` : '#';
            return (
              <li key={i.productId}>
                <Link href={href} className="block overflow-hidden rounded-[var(--radius-card)] bg-sand">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {t?.images[0] ? <img src={t.images[0].url} alt="" className="aspect-[4/5] w-full object-cover" /> : <span className="block aspect-[4/5]" />}
                </Link>
                <p className="mt-2 text-sm font-medium">{i.productName ?? 'Producto'}</p>
                <p className="text-sm">{formatMoney(i.priceWithTax)}</p>
                {!i.inStock && <p className="text-xs text-danger">Agotado: te avisamos cuando vuelva</p>}
                <div className="mt-2 space-y-1 text-xs">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="accent-ink" checked={i.notifyPriceDrop} onChange={safe(() => update(i.productId, { notifyPriceDrop: !i.notifyPriceDrop }))} />
                    Avisarme si baja de precio
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="accent-ink" checked={i.notifyBackInStock} onChange={safe(() => update(i.productId, { notifyBackInStock: !i.notifyBackInStock }))} />
                    Avisarme si vuelve a haber stock
                  </label>
                </div>
                <button type="button" className="mt-2 text-xs text-ink-soft underline" onClick={safe(() => toggle(i.productId))}>
                  Quitar
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
