import { listingMetadata, listingPage } from '@/lib/listing-pages';

export async function generateMetadata({ searchParams }: PageProps<'/filtrado/ofertas'>) {
  return listingMetadata({ kind: 'sale' }, await searchParams);
}

export default async function Page({ searchParams }: PageProps<'/filtrado/ofertas'>) {
  return listingPage({ kind: 'sale' }, await searchParams);
}
