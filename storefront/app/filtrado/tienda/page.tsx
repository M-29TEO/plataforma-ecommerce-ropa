import { listingMetadata, listingPage } from '@/lib/listing-pages';

export async function generateMetadata({ searchParams }: PageProps<'/filtrado/tienda'>) {
  return listingMetadata({ kind: 'all' }, await searchParams);
}

export default async function Page({ searchParams }: PageProps<'/filtrado/tienda'>) {
  return listingPage({ kind: 'all' }, await searchParams);
}
