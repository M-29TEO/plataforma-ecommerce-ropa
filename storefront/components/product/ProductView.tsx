'use client';

import { useMemo, useState } from 'react';
import { errorMessage, isApiError } from '@/lib/api/client';
import type { ProductDetail } from '@/lib/types';
import { findVariant, fitAdvice, imagesForColor, initialColor, sizeAvailability } from '@/lib/variants';
import { WishlistButton } from '../account/WishlistButton';
import { Price } from '../catalog/Price';
import { Stars } from '../catalog/Stars';
import { useCart } from '../providers/CartProvider';
import { useToast } from '../providers/ToastProvider';
import { Gallery } from './Gallery';
import { SizeGuide } from './SizeGuide';

export function ProductView({ product, fit }: { product: ProductDetail; fit: { small: number; true: number; large: number } | null }) {
  const [color, setColor] = useState<string | null>(() => initialColor(product));
  const [size, setSize] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [sizeError, setSizeError] = useState(false);
  const { add, setOpen } = useCart();
  const toast = useToast();

  const images = useMemo(() => imagesForColor(product.media, color), [product.media, color]);
  const sizes = useMemo(() => sizeAvailability(product, color), [product, color]);
  const needsSize = product.sizes.length > 0;
  const variant = findVariant(product, color, needsSize ? size : null);
  const advice = fitAdvice(fit);

  async function addToCart() {
    if (needsSize && !size) {
      setSizeError(true);
      document.getElementById('size-picker')?.focus();
      return;
    }
    if (!variant) return;
    setBusy(true);
    try {
      await add(variant.id, qty);
      setOpen(true);
    } catch (error) {
      toast(isApiError(error, 'INSUFFICIENT_STOCK') ? 'No hay tantas unidades de esa talla.' : errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-12">
      <Gallery key={color ?? 'all'} images={images} name={product.name} />
      <div>
        {product.brand && (
          <a href={`/marca/${product.brand.slug}`} className="text-sm uppercase tracking-wide text-ink-soft hover:text-ink">
            {product.brand.name}
          </a>
        )}
        <h1 className="mt-1 text-3xl sm:text-4xl">{product.name}</h1>
        {product.ratingCount > 0 && (
          <a href="#resenas" className="mt-2 inline-block">
            <Stars value={Number(product.ratingAvg)} count={product.ratingCount} />
          </a>
        )}
        <div className="mt-4">
          <Price price={variant?.price ?? product.price} compareAt={variant ? variant.compareAtPrice : product.compareAtPrice} size="lg" />
          <p className="mt-1 text-xs text-ink-soft">IVA incluido</p>
        </div>

        {product.colors.length > 0 && (
          <fieldset className="mt-6">
            <legend className="text-sm">
              Color: <span className="font-semibold">{color}</span>
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {product.colors.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => {
                    setColor(c.name);
                    setSize(null);
                  }}
                  aria-pressed={color === c.name}
                  aria-label={c.name}
                  title={c.name}
                  className={`h-9 w-9 rounded-full border border-line ring-offset-2 ${color === c.name ? 'ring-2 ring-ink' : ''}`}
                  style={{ background: c.hex ?? '#ccc' }}
                />
              ))}
            </div>
          </fieldset>
        )}

        {needsSize && (
          <fieldset className="mt-6">
            <div className="flex items-center justify-between">
              <legend className="text-sm">
                Talla{size && <>: <span className="font-semibold">{size}</span></>}
              </legend>
              {product.sizeChart && <SizeGuide chart={product.sizeChart} advice={advice} />}
            </div>
            <div id="size-picker" tabIndex={-1} className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Talla" aria-invalid={sizeError}>
              {sizes.map(({ size: s, stock }) => {
                const out = stock === null || stock === 'out_of_stock';
                return (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={size === s}
                    disabled={out}
                    onClick={() => {
                      setSize(s);
                      setSizeError(false);
                    }}
                    className={`relative min-w-12 rounded-lg border px-3 py-2 text-sm ${
                      size === s ? 'border-ink bg-ink text-paper' : out ? 'border-line text-ink-soft/50 line-through' : 'border-line bg-white hover:border-ink'
                    }`}
                  >
                    {s}
                    {out && <span className="sr-only"> (agotada)</span>}
                  </button>
                );
              })}
            </div>
            {sizeError && <p className="mt-2 text-sm text-danger">Elige una talla.</p>}
            {advice && <p className="mt-2 text-xs text-ink-soft">{advice}</p>}
          </fieldset>
        )}

        <div className="mt-4 min-h-6 text-sm" aria-live="polite">
          {variant?.stock === 'low' && <span className="font-medium text-warn">¡Quedan pocas unidades!</span>}
          {variant?.stock === 'in_stock' && <span className="text-ok">Disponible · entrega desde hoy en Quito</span>}
          {variant?.stock === 'out_of_stock' && <span className="text-danger">Agotado en esta talla</span>}
        </div>

        <div className="mt-4 flex gap-2">
          <label className="sr-only" htmlFor="qty">
            Cantidad
          </label>
          <select id="qty" className="rounded-full border border-line bg-white px-4" value={qty} onChange={(e) => setQty(Number(e.target.value))}>
            {Array.from({ length: variant?.stock === 'low' ? 3 : 10 }, (_, i) => i + 1).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          <button type="button" className="btn-accent flex-1 py-3 text-base" disabled={busy || variant?.stock === 'out_of_stock'} onClick={addToCart}>
            {busy ? 'Agregando…' : 'Agregar al carrito'}
          </button>
          <WishlistButton productId={product.id} compact />
        </div>

        <ul className="mt-6 space-y-2 border-t border-line pt-5 text-sm text-ink-soft">
          <li>🚚 Envío con motorizado en Quito o por courier a todo el país.</li>
          <li>💳 Tarjeta, DeUna, transferencia o pago contra entrega.</li>
          <li>↩︎ 30 días para cambios y devoluciones.</li>
        </ul>
      </div>
    </div>
  );
}
