import { listingMetadata, listingPage } from '@/lib/listing-pages';

/** ISR: cada categoría se genera en la primera visita y se regenera cada 5 minutos. */
export const revalidate = 300;
export const generateStaticParams = async () => [];

export async function generateMetadata({ params }: PageProps<'/categoria/[...path]'>) {
  return listingMetadata({ kind: 'category', path: (await params).path }, null);
}

export default async function Page({ params }: PageProps<'/categoria/[...path]'>) {
  return listingPage({ kind: 'category', path: (await params).path }, null);
}
