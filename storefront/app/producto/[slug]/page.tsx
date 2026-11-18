import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '@/components/catalog/Breadcrumbs';
import { ProductCard } from '@/components/catalog/ProductCard';
import { ProductView } from '@/components/product/ProductView';
import { Questions } from '@/components/product/Questions';
import { Reviews } from '@/components/product/Reviews';
import { apiGet, catalog } from '@/lib/api/server';
import type { ReviewsPage } from '@/lib/commerce-types';
import { SITE_URL, STORE_NAME } from '@/lib/config';
import type { ProductDetail } from '@/lib/types';

/** ISR: la ficha se genera en la primera visita y se regenera cada 5 minutos (precio y stock). */
export const revalidate = 300;
export const generateStaticParams = async () => [];

export async function generateMetadata({ params }: PageProps<'/producto/[slug]'>): Promise<Metadata> {
  const p = await catalog.product((await params).slug);
  if (!p) return { title: 'Producto no encontrado' };
  const title = p.seo.title?.replace(` | ${STORE_NAME}`, '') ?? p.name;
  const description = p.seo.description ?? p.description?.slice(0, 155) ?? `${p.name} en ${STORE_NAME}`;
  const image = p.media[0]?.url;
  return {
    title,
    description,
    alternates: { canonical: `/producto/${p.slug}` },
    openGraph: { type: 'website', title, description, images: image ? [{ url: image, width: 800, height: 1000, alt: p.name }] : undefined },
  };
}

function productJsonLd(p: ProductDetail) {
  const prices = p.variants.map((v) => Number(v.price));
  const inStock = p.variants.some((v) => v.stock !== 'out_of_stock');
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: p.description ?? undefined,
    sku: p.variants[0]?.sku,
    image: p.media.map((m) => `${SITE_URL}${m.url}`),
    brand: p.brand ? { '@type': 'Brand', name: p.brand.name } : undefined,
    material: p.material ?? undefined,
    color: p.colors.map((c) => c.name).join(', ') || undefined,
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'USD',
      lowPrice: Math.min(...prices).toFixed(2),
      highPrice: Math.max(...prices).toFixed(2),
      offerCount: p.variants.length,
      availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: `${SITE_URL}/producto/${p.slug}`,
    },
    aggregateRating: p.ratingCount > 0 ? { '@type': 'AggregateRating', ratingValue: p.ratingAvg, reviewCount: p.ratingCount } : undefined,
  };
}

export default async function Page({ params }: PageProps<'/producto/[slug]'>) {
  const product = await catalog.product((await params).slug);
  if (!product) notFound();
  // Primera página de reseñas en el HTML (SEO); el resto se carga en el navegador.
  const reviews = await apiGet<ReviewsPage>(`/products/${product.id}/reviews?limit=5`).catch(() => null);

  const crumbs = [...product.breadcrumb.map((c) => ({ name: c.name, href: `/categoria/${c.path}` })), { name: product.name, href: `/producto/${product.slug}` }];

  return (
    <div className="container-page py-6">
      <Breadcrumbs items={crumbs} />
      <ProductView product={product} fit={reviews?.summary.fit ?? null} />

      <section aria-labelledby="desc" className="mt-14 grid gap-8 border-t border-line pt-10 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 id="desc" className="text-2xl">
            Descripción
          </h2>
          <p className="mt-3 leading-relaxed text-ink-soft">{product.description}</p>
        </div>
        <dl className="space-y-3 text-sm">
          {product.material && (
            <div>
              <dt className="font-semibold">Material</dt>
              <dd className="text-ink-soft">{product.material}</dd>
            </div>
          )}
          {typeof product.attributes.fit === 'string' && (
            <div>
              <dt className="font-semibold">Corte</dt>
              <dd className="text-ink-soft">{product.attributes.fit}</dd>
            </div>
          )}
          {product.careInstructions && (
            <div>
              <dt className="font-semibold">Cuidados</dt>
              <dd className="text-ink-soft">{product.careInstructions}</dd>
            </div>
          )}
        </dl>
      </section>

      <Reviews productId={product.id} initial={reviews} />
      <Questions productId={product.id} />

      {product.related.length > 0 && (
        <section aria-labelledby="related" className="mt-16">
          <h2 id="related" className="text-2xl">
            También te puede gustar
          </h2>
          <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-4">
            {product.related.slice(0, 4).map((p) => (
              <li key={p.id}>
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd(product)).replace(/</g, '\\u003c') }} />
    </div>
  );
}
