import { listingMetadata, listingPage } from '@/lib/listing-pages';

/**
 * Sin parámetros de ruta: se renderiza por petición (los datos del API quedan en la caché de 5 min).
 * No se pregenera en el build porque la imagen se construye sin la API disponible.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  return listingMetadata({ kind: 'all' }, null);
}

export default async function Page() {
  return listingPage({ kind: 'all' }, null);
}
