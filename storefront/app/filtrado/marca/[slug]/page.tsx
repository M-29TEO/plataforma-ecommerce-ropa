import { listingMetadata, listingPage } from '@/lib/listing-pages';

export async function generateMetadata({ params, searchParams }: PageProps<'/filtrado/marca/[slug]'>) {
  return listingMetadata({ kind: 'brand', slug: (await params).slug }, await searchParams);
}

export default async function Page({ params, searchParams }: PageProps<'/filtrado/marca/[slug]'>) {
  return listingPage({ kind: 'brand', slug: (await params).slug }, await searchParams);
}
