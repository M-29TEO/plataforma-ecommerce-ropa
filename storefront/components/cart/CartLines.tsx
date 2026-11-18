'use client';

import Link from 'next/link';
import { useState } from 'react';
import { errorMessage } from '@/lib/api/client';
import type { CartLine } from '@/lib/commerce-types';
import { formatMoney } from '@/lib/format';
import { useCart } from '../providers/CartProvider';
import { useToast } from '../providers/ToastProvider';

/** Foto de la línea: la del color elegido si existe, si no la primera del producto. */
function lineImage(line: CartLine, thumbs: ReturnType<typeof useCart>['thumbs']) {
  const t = line.productId ? thumbs[line.productId] : undefined;
  if (!t) return { url: null as string | null, slug: null as string | null };
  const byColor = t.images.find((i) => i.colorName === line.colorName);
  return { url: (byColor ?? t.images[0])?.url ?? null, slug: t.slug };
}

export function CartLines({ compact = false }: { compact?: boolean }) {
  const { cart, thumbs, update, remove } = useCart();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  if (!cart || cart.items.length === 0) return null;

  async function run(variantId: string, fn: () => Promise<void>) {
    setBusy(variantId);
    try {
      await fn();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="divide-y divide-line">
      {cart.items.map((line) => {
        const { url, slug } = lineImage(line, thumbs);
        const max = Math.max(1, Math.min(20, line.availableQuantity || line.quantity));
        return (
          <li key={line.variantId} className={`flex gap-3 py-4 ${busy === line.variantId ? 'opacity-60' : ''}`}>
            <Link href={slug ? `/producto/${slug}` : '#'} className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {url ? <img src={url} alt="" className={`${compact ? 'h-24 w-20' : 'h-32 w-24'} rounded-lg object-cover`} /> : <span className="block h-24 w-20 rounded-lg bg-sand" />}
            </Link>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex justify-between gap-2">
                <div className="min-w-0">
                  {line.brandName && <p className="text-xs uppercase tracking-wide text-ink-soft">{line.brandName}</p>}
                  <p className="truncate text-sm font-medium">{line.productName ?? 'Producto no disponible'}</p>
                  <p className="text-xs text-ink-soft">{[line.colorName, line.sizeCode && `Talla ${line.sizeCode}`].filter(Boolean).join(' · ')}</p>
                </div>
                <p className="text-sm font-semibold">{formatMoney(line.total)}</p>
              </div>
              {line.issues.map((issue) => (
                <p key={issue.code} className={`mt-1 text-xs ${issue.code === 'PRICE_CHANGED' ? 'text-warn' : 'text-danger'}`}>
                  {issue.message}
                </p>
              ))}
              <div className="mt-auto flex items-center gap-3 pt-2">
                <label className="sr-only" htmlFor={`qty-${line.variantId}`}>
                  Cantidad
                </label>
                <select
                  id={`qty-${line.variantId}`}
                  className="rounded-full border border-line bg-white px-3 py-1 text-sm"
                  value={line.quantity}
                  disabled={busy !== null || !line.billable}
                  onChange={(e) => run(line.variantId, () => update(line.variantId, Number(e.target.value)))}
                >
                  {Array.from({ length: Math.max(max, line.quantity) }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <button type="button" className="text-xs text-ink-soft underline hover:text-ink" disabled={busy !== null} onClick={() => run(line.variantId, () => remove(line.variantId))}>
                  Quitar
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function CartTotals() {
  const { cart } = useCart();
  if (!cart) return null;
  const t = cart.totals;
  return (
    <dl className="space-y-1.5 text-sm">
      <div className="flex justify-between">
        <dt>Subtotal</dt>
        <dd>{formatMoney(t.subtotal)}</dd>
      </div>
      {Number(t.discountTotal) > 0 && (
        <div className="flex justify-between text-ok">
          <dt>Descuentos</dt>
          <dd>-{formatMoney(t.discountTotal)}</dd>
        </div>
      )}
      <div className="flex justify-between text-ink-soft">
        <dt>IVA</dt>
        <dd>{formatMoney(t.taxTotal)}</dd>
      </div>
      <div className="flex justify-between text-ink-soft">
        <dt>Envío</dt>
        <dd>{cart.freeShipping ? 'Gratis' : 'Se calcula en el checkout'}</dd>
      </div>
      <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
        <dt>Total</dt>
        <dd>{formatMoney(t.total)}</dd>
      </div>
      {cart.hints.map((h) => (
        <p key={h.promotionId} className="rounded-lg bg-sand px-3 py-2 text-xs">
          {h.name}: {h.missing}
        </p>
      ))}
    </dl>
  );
}
