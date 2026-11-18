import type { MetadataRoute } from 'next';
import { catalog } from '@/lib/api/server';
import { SITE_URL } from '@/lib/config';

/** Se genera por petición (con los datos del API en caché): la imagen se construye sin API. */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const fixed: MetadataRoute.Sitemap = ['', '/tienda', '/ofertas', '/envios', '/guia-de-tallas'].map((p) => ({ url: `${SITE_URL}${p}`, changeFrequency: 'daily', priority: p === '' ? 1 : 0.6 }));
  const entries = await catalog.sitemap().catch(() => []);
  return [
    ...fixed,
    ...entries.map((e) => ({
      url: `${SITE_URL}${e.type === 'product' ? '/producto/' : e.type === 'brand' ? '/marca/' : '/categoria/'}${e.key}`,
      lastModified: e.updatedAt ?? undefined,
      changeFrequency: e.type === 'product' ? ('weekly' as const) : ('daily' as const),
      priority: e.type === 'product' ? 0.8 : 0.7,
    })),
  ];
}
