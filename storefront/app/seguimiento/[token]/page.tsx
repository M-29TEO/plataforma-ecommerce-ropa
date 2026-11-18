import type { Metadata } from 'next';
import { TrackingView } from '@/components/tracking/TrackingView';

export const metadata: Metadata = { title: 'Seguimiento de tu pedido', robots: { index: false, follow: false } };

/** Enlace público de seguimiento (lo envían los emails y push): el token es la llave, sin sesión. */
export default async function Page({ params }: PageProps<'/seguimiento/[token]'>) {
  const { token } = await params;
  return <TrackingView token={token} />;
}
