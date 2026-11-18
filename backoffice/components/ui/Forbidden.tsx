import Link from 'next/link';

/** La ruta existe pero el rol del usuario no la incluye (la API respondería 403 de todos modos). */
export function Forbidden() {
  return (
    <div className="card mx-auto mt-10 max-w-md p-6 text-center">
      <p className="text-4xl font-semibold text-ink-soft">403</p>
      <h1 className="mt-2 text-lg font-semibold">Tu rol no tiene acceso a esta pantalla</h1>
      <p className="mt-2 text-sm text-ink-soft">Si lo necesitas para tu trabajo, pide a un administrador que te asigne el rol correspondiente.</p>
      <Link href="/" className="btn-primary mt-5">Ir al inicio</Link>
    </div>
  );
}
