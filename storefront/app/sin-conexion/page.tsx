import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sin conexión', robots: { index: false } };

/** La muestra el service worker cuando no hay red y la página no está en caché. */
export default function Offline() {
  return (
    <div className="container-page py-24 text-center">
      <h1 className="text-3xl">Estás sin conexión</h1>
      <p className="mt-3 text-ink-soft">Revisa tu internet. Las páginas que ya visitaste siguen disponibles.</p>
    </div>
  );
}
