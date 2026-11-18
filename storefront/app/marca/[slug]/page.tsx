import { listingMetadata, listingPage } from '@/lib/listing-pages';

export const revalidate = 300;
export const generateStaticParams = async () => [];

export async function generateMetadata({ params }: PageProps<'/marca/[slug]'>) {
  return listingMetadata({ kind: 'brand', slug: (await params).slug }, null);
}

export default async function Page({ params }: PageProps<'/marca/[slug]'>) {
  return listingPage({ kind: 'brand', slug: (await params).slug }, null);
}
