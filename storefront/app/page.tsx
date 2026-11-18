import Link from 'next/link';
import { ProductCard } from '@/components/catalog/ProductCard';
import { InstallAppButton } from '@/components/pwa/InstallAppButton';
import { catalog } from '@/lib/api/server';
import { STORE_NAME } from '@/lib/config';
import { parseFilters, toApiQuery } from '@/lib/filters';
import type { Brand, ListingPage } from '@/lib/types';

/**
 * Home: SSR por petición con los datos del API en caché 5 minutos (fetch con revalidate). No se
 * pregenera en el build porque la imagen Docker se construye sin la API disponible.
 */
export const dynamic = 'force-dynamic';

const empty: ListingPage = { items: [], total: 0, page: 1, pageSize: 0, facets: { brands: [], colors: [], sizes: [], genders: [], price: { min: null, max: null } } };

const TILES = [
  { path: 'mujer', title: 'Mujer', text: 'Vestidos, blusas y jeans', image: '/media/demo/vestido-terracota.svg' },
  { path: 'hombre', title: 'Hombre', text: 'Camisas, jeans y chaquetas', image: '/media/demo/camisa-celeste.svg' },
  { path: 'unisex', title: 'Unisex', text: 'Camisetas y sudaderas', image: '/media/demo/sudadera-verde-oliva.svg' },
];

export default async function Home() {
  const latestQ = toApiQuery({ ...parseFilters({}), page: 1 });
  latestQ.set('pageSize', '8');
  const saleQ = toApiQuery({ ...parseFilters({}), onSale: true, sort: 'precio-asc' });
  saleQ.set('pageSize', '4');
  const [latest, sale, brands] = await Promise.all([
    catalog.products(latestQ).catch(() => empty),
    catalog.products(saleQ).catch(() => empty),
    catalog.brands().catch(() => [] as Brand[]),
  ]);

  return (
    <>
      <section className="relative overflow-hidden bg-sand">
        <div className="container-page grid items-center gap-8 py-14 md:grid-cols-2 md:py-20">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-accent-dark">Nueva temporada</p>
            <h1 className="mt-3 text-4xl leading-tight sm:text-5xl">Moda hecha en Ecuador, entregada hoy en tu puerta.</h1>
            <p className="mt-4 max-w-md text-ink-soft">Lino de la Costa, alpaca de la Sierra y denim para todos los días. Sigue a tu motorizado en vivo hasta que llegue.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/tienda" className="btn-primary px-6 py-3">
                Comprar ahora
              </Link>
              <Link href="/ofertas" className="btn-ghost px-6 py-3">
                Ver ofertas
              </Link>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4" aria-hidden>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/media/demo/vestido-beige.svg" alt="" className="aspect-[4/5] w-full rounded-2xl object-cover shadow-sm" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/media/demo/chaqueta-terracota.svg" alt="" className="mt-10 aspect-[4/5] w-full rounded-2xl object-cover shadow-sm" />
          </div>
        </div>
      </section>

      <section aria-labelledby="cats" className="container-page mt-14">
        <h2 id="cats" className="sr-only">
          Categorías
        </h2>
        <ul className="grid gap-4 sm:grid-cols-3">
          {TILES.map((t) => (
            <li key={t.path}>
              <Link href={`/categoria/${t.path}`} className="group relative block overflow-hidden rounded-2xl bg-sand">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={t.image} alt="" className="aspect-[4/3] w-full object-cover transition-transform duration-500 group-hover:scale-105" />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/70 to-transparent p-5 text-paper">
                  <p className="font-display text-2xl">{t.title}</p>
                  <p className="text-sm opacity-90">{t.text}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {latest.items.length > 0 && (
        <section aria-labelledby="new" className="container-page mt-16">
          <div className="flex items-end justify-between">
            <h2 id="new" className="text-3xl">
              Novedades
            </h2>
            <Link href="/tienda" className="text-sm underline">
              Ver todo
            </Link>
          </div>
          <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-4">
            {latest.items.map((p) => (
              <li key={p.id}>
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {sale.items.length > 0 && (
        <section aria-labelledby="sale" className="mt-16 bg-ink py-14 text-paper">
          <div className="container-page">
            <div className="flex items-end justify-between">
              <h2 id="sale" className="text-3xl">
                Ofertas de la semana
              </h2>
              <Link href="/ofertas" className="text-sm underline">
                Ver todas
              </Link>
            </div>
            <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-4 [&_a]:text-paper [&_.text-ink-soft]:text-paper/70 [&_.text-accent-dark]:text-accent-light">
              {sale.items.map((p) => (
                <li key={p.id}>
                  <ProductCard product={p} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {brands.length > 0 && (
        <section aria-labelledby="brands" className="container-page mt-16">
          <h2 id="brands" className="text-center text-2xl">
            Nuestras marcas
          </h2>
          <ul className="mt-6 flex flex-wrap justify-center gap-3">
            {brands.map((b) => (
              <li key={b.slug}>
                <Link href={`/marca/${b.slug}`} className="chip px-5 py-2 text-sm hover:border-ink">
                  {b.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="container-page mt-16 grid gap-6 sm:grid-cols-3">
        {[
          ['Entrega el mismo día', 'En Quito con motorizado propio, en la franja que elijas.'],
          ['Síguelo en vivo', 'Ve al motorizado en el mapa y recibe avisos en tu teléfono.'],
          ['Paga como prefieras', 'Tarjeta, DeUna, transferencia o efectivo al recibir.'],
        ].map(([t, d]) => (
          <div key={t} className="card p-6">
            <p className="font-display text-lg">{t}</p>
            <p className="mt-1 text-sm text-ink-soft">{d}</p>
          </div>
        ))}
      </section>

      <section className="container-page mt-12">
        <div className="card flex flex-wrap items-center justify-between gap-4 p-6">
          <div>
            <p className="font-display text-xl">Lleva {STORE_NAME} en tu teléfono</p>
            <p className="text-sm text-ink-soft">Instala la app: funciona sin conexión y te avisa cuando tu pedido está en camino.</p>
          </div>
          <InstallAppButton />
        </div>
      </section>
    </>
  );
}
