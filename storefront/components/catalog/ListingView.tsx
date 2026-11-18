import { catalog } from '@/lib/api/server';
import { type Filters, hasActiveFilters, type SortKey, toApiQuery } from '@/lib/filters';
import { Breadcrumbs, type Crumb } from './Breadcrumbs';
import { FilterPanel } from './FilterPanel';
import { Pagination } from './Pagination';
import { ProductCard } from './ProductCard';
import { SortSelect } from './SortSelect';

export interface ListingBase {
  category?: string;
  brand?: string;
  collection?: string;
  onSale?: boolean;
}

/**
 * Listado del catálogo. La misma vista sirve para la versión estática (ISR, sin filtros: la que
 * indexan los buscadores) y para la dinámica (SSR por petición, con filtros/orden/página).
 */
export async function ListingView({
  title,
  intro,
  basePath,
  base,
  filters,
  crumbs,
  defaultSort = 'novedades',
  dynamic,
}: {
  title: string;
  intro?: string;
  basePath: string;
  base: ListingBase;
  filters: Filters;
  crumbs: Crumb[];
  defaultSort?: SortKey;
  /** SSR por petición: reenvía la IP del visitante y no cachea. */
  dynamic: boolean;
}) {
  const query = toApiQuery(base.onSale ? { ...filters, onSale: true } : filters, base);
  const data = await catalog.products(query, dynamic ? { revalidate: false, forwardClientIp: true } : undefined);
  const active = hasActiveFilters(filters);

  return (
    <div className="container-page py-8">
      <Breadcrumbs items={crumbs} />
      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl sm:text-4xl">{title}</h1>
          {intro && <p className="mt-2 max-w-2xl text-ink-soft">{intro}</p>}
          <p className="mt-1 text-sm text-ink-soft" aria-live="polite">
            {data.total} {data.total === 1 ? 'producto' : 'productos'}
          </p>
        </div>
        <SortSelect basePath={basePath} filters={filters} defaultSort={defaultSort} withRelevance={!!filters.q} />
      </div>
      <div className="mt-6 grid gap-8 lg:grid-cols-[240px_1fr]">
        <FilterPanel basePath={basePath} filters={filters} facets={data.facets} defaultSort={defaultSort} hideBrand={!!base.brand} hideSale={!!base.onSale} />
        <section aria-labelledby="products-title">
          {/* Las tarjetas usan h3: este h2 evita el salto h1 → h3 para lectores de pantalla. */}
          <h2 id="products-title" className="sr-only">
            Productos
          </h2>
          {data.items.length === 0 ? (
            <div className="card p-10 text-center">
              <p className="font-display text-xl">No encontramos productos{active ? ' con esos filtros' : ''}.</p>
              <p className="mt-2 text-sm text-ink-soft">{active ? 'Prueba quitando alguno.' : 'Vuelve pronto: llegan novedades cada semana.'}</p>
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 xl:grid-cols-4">
              {data.items.map((p, i) => (
                <li key={p.id}>
                  <ProductCard product={p} preload={i < 4} />
                </li>
              ))}
            </ul>
          )}
          <Pagination basePath={basePath} filters={filters} total={data.total} defaultSort={defaultSort} />
        </section>
      </div>
    </div>
  );
}
