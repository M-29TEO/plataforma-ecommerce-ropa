import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="container-page py-24 text-center">
      <p className="text-sm uppercase tracking-widest text-ink-soft">Error 404</p>
      <h1 className="mt-2 text-4xl">No encontramos esta página</h1>
      <p className="mt-3 text-ink-soft">Puede que el producto ya no esté disponible o que el enlace tenga un error.</p>
      <div className="mt-8 flex justify-center gap-3">
        <Link href="/" className="btn-primary">
          Ir al inicio
        </Link>
        <Link href="/buscar" className="btn-ghost">
          Buscar
        </Link>
      </div>
    </div>
  );
}
