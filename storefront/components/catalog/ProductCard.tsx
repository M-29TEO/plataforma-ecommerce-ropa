import Link from 'next/link';
import type { ProductCard as Card } from '@/lib/types';
import { WishlistButton } from '../account/WishlistButton';
import { Price } from './Price';
import { ProductImage } from './ProductImage';
import { Stars } from './Stars';

export function ProductCard({ product, preload = false }: { product: Card; preload?: boolean }) {
  const [first, second] = product.images;
  return (
    <article className="group relative">
      <Link href={`/producto/${product.slug}`} className="block">
        <div className="relative overflow-hidden rounded-[var(--radius-card)] bg-sand">
          <ProductImage src={first?.url} alt={first?.alt ?? product.name} preload={preload} />
          {second && (
            <ProductImage
              src={second.url}
              alt=""
              className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            />
          )}
          {!product.available && <span className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-xs font-medium">Agotado</span>}
          {product.available && product.compareAtPrice && (
            <span className="absolute left-2 top-2 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-white">Oferta</span>
          )}
        </div>
        <div className="mt-3 space-y-1">
          {product.brand && <p className="text-xs uppercase tracking-wide text-ink-soft">{product.brand.name}</p>}
          <h3 className="line-clamp-2 font-sans text-sm font-medium">{product.name}</h3>
          <Price price={product.price} compareAt={product.compareAtPrice} />
          {product.ratingCount > 0 && <Stars value={Number(product.ratingAvg)} count={product.ratingCount} small />}
        </div>
      </Link>
      {product.colors.length > 1 && (
        <ul className="mt-2 flex gap-1" aria-label="Colores disponibles">
          {product.colors.slice(0, 6).map((c) => (
            <li key={c.name} title={c.name} className="h-3.5 w-3.5 rounded-full border border-line" style={{ background: c.hex ?? '#ccc' }}>
              <span className="sr-only">{c.name}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="absolute right-2 top-2">
        <WishlistButton productId={product.id} compact />
      </div>
    </article>
  );
}
