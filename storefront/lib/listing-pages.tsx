import 'server-only';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ListingView } from '@/components/catalog/ListingView';
import { catalog } from './api/server';
import { type Filters, hasActiveFilters, parseFilters, toUrlSearch } from './filters';

/**
 * Páginas de listado. Cada una existe dos veces con el mismo contenido:
 *  - /categoria/... (ISR): sin filtros, la URL canónica que indexan los buscadores;
 *  - /filtrado/categoria/... (SSR): proxy.ts reescribe aquí cuando hay filtros, orden o página.
 */
type SP = Record<string, string | string[] | undefined>;

export type ListingKind =
  | { kind: 'category'; path: string[] }
  | { kind: 'brand'; slug: string }
  | { kind: 'all' }
  | { kind: 'sale' };

interface Resolved {
  title: string;
  intro?: string;
  basePath: string;
  base: { category?: string; brand?: string; onSale?: boolean };
  crumbs: Array<{ name: string; href: string }>;
}

async function resolve(k: ListingKind): Promise<Resolved | null> {
  if (k.kind === 'all') return { title: 'Toda la tienda', basePath: '/tienda', base: {}, crumbs: [{ name: 'Tienda', href: '/tienda' }] };
  if (k.kind === 'sale')
    return {
      title: 'Ofertas',
      intro: 'Prendas con precio rebajado por tiempo limitado.',
      basePath: '/ofertas',
      base: { onSale: true },
      crumbs: [{ name: 'Ofertas', href: '/ofertas' }],
    };
  if (k.kind === 'brand') {
    const brand = (await catalog.brands()).find((b) => b.slug === k.slug);
    if (!brand) return null;
    return { title: brand.name, basePath: `/marca/${brand.slug}`, base: { brand: brand.slug }, crumbs: [{ name: brand.name, href: `/marca/${brand.slug}` }] };
  }
  const path = k.path.map(decodeURIComponent).join('/');
  const categories = await catalog.categories();
  const category = categories.find((c) => c.path === path);
  if (!category) return null;
  const crumbs = categories
    .filter((c) => path === c.path || path.startsWith(`${c.path}/`))
    .sort((a, b) => a.path.length - b.path.length)
    .map((c) => ({ name: c.name, href: `/categoria/${c.path}` }));
  const parent = categories.find((c) => c.path === category.parentPath);
  return {
    title: parent ? `${category.name} de ${parent.name.toLowerCase()}` : category.name,
    basePath: `/categoria/${category.path}`,
    base: { category: category.path },
    crumbs,
  };
}

export async function listingPage(k: ListingKind, sp: SP | null) {
  const r = await resolve(k);
  if (!r) notFound();
  const filters = sp ? parseFilters(sp) : parseFilters({});
  return <ListingView title={r.title} intro={r.intro} basePath={r.basePath} base={r.base} filters={filters} crumbs={r.crumbs} dynamic={sp !== null} />;
}

export async function listingMetadata(k: ListingKind, sp: SP | null): Promise<Metadata> {
  const r = await resolve(k);
  if (!r) return { title: 'No encontrado' };
  const filters: Filters = sp ? parseFilters(sp) : parseFilters({});
  const description = r.intro ?? `${r.title}: compra en línea con envío a domicilio en Ecuador, pago seguro y seguimiento en vivo.`;
  // Combinaciones de filtros: no se indexan (contenido casi duplicado) pero sí se siguen los enlaces.
  // La paginación sí es indexable, con su propia URL canónica.
  const filtered = hasActiveFilters(filters) || filters.sort !== 'novedades';
  const canonical = filtered ? r.basePath : `${r.basePath}${toUrlSearch({ ...parseFilters({}), page: filters.page })}`;
  return {
    title: filters.page > 1 ? `${r.title} · página ${filters.page}` : r.title,
    description,
    alternates: { canonical },
    robots: filtered ? { index: false, follow: true } : undefined,
    openGraph: { title: r.title, description },
  };
}
