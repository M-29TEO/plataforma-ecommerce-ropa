import { listingMetadata, listingPage } from '@/lib/listing-pages';

/** SSR: categoría con filtros, orden o página (proxy.ts reescribe /categoria/...?talla=M hacia aquí). */
export async function generateMetadata({ params, searchParams }: PageProps<'/filtrado/categoria/[...path]'>) {
  return listingMetadata({ kind: 'category', path: (await params).path }, await searchParams);
}

export default async function Page({ params, searchParams }: PageProps<'/filtrado/categoria/[...path]'>) {
  return listingPage({ kind: 'category', path: (await params).path }, await searchParams);
}
