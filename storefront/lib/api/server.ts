import 'server-only';
import { headers } from 'next/headers';
import { serverApiBase, storeTenantId } from '../config';
import type { Brand, CategoryNode, Collection, ListingPage, ProductDetail, SitemapEntry } from '../types';
import { ApiError, toApiError } from './errors';

/** Segundos de ISR del catálogo: el API además cachea 60 s. */
export const CATALOG_REVALIDATE = 300;

interface Options {
  /** ISR: segundos; false = sin caché (SSR por petición). */
  revalidate?: number | false;
  /** Reenvía la IP del visitante (SSR por petición): el rate limit del API es por IP, no por el servidor de Next. */
  forwardClientIp?: boolean;
}

/** GET al API desde el servidor (RSC), con el tenant de la tienda. */
export async function apiGet<T>(path: string, opts: Options = {}): Promise<T> {
  const h: Record<string, string> = { 'X-Tenant-Id': storeTenantId(), Accept: 'application/json' };
  if (opts.forwardClientIp) {
    const incoming = await headers();
    const ip = incoming.get('x-forwarded-for');
    if (ip) h['X-Forwarded-For'] = ip;
  }
  const res = await fetch(`${serverApiBase()}${path}`, {
    headers: h,
    ...(opts.revalidate === false ? { cache: 'no-store' as const } : { next: { revalidate: opts.revalidate ?? CATALOG_REVALIDATE } }),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/** null si el API responde 404 (para llamar a notFound()). */
export async function apiGetOrNull<T>(path: string, opts: Options = {}): Promise<T | null> {
  try {
    return await apiGet<T>(path, opts);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export const catalog = {
  products: (query: URLSearchParams, opts?: Options) => apiGet<ListingPage>(`/catalog/products?${query}`, opts),
  product: (slug: string) => apiGetOrNull<ProductDetail>(`/catalog/products/${encodeURIComponent(slug)}`),
  categories: () => apiGet<CategoryNode[]>('/catalog/categories'),
  brands: () => apiGet<Brand[]>('/catalog/brands'),
  collections: () => apiGet<Collection[]>('/catalog/collections'),
  sitemap: () => apiGet<SitemapEntry[]>('/catalog/sitemap'),
};
