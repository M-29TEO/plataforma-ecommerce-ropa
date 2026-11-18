import type { Metadata } from 'next';
import { ListingView } from '@/components/catalog/ListingView';
import { parseFilters } from '@/lib/filters';

/** Búsqueda: SSR por petición (texto libre: no tiene sentido pregenerarla ni indexarla). */
export async function generateMetadata({ searchParams }: PageProps<'/buscar'>): Promise<Metadata> {
  const { q } = parseFilters(await searchParams, 'relevancia');
  return { title: q ? `Buscar «${q}»` : 'Buscar', robots: { index: false, follow: true } };
}

export default async function Page({ searchParams }: PageProps<'/buscar'>) {
  const filters = parseFilters(await searchParams, 'relevancia');
  if (!filters.q) {
    return (
      <div className="container-page py-16">
        <h1 className="text-3xl">Buscar</h1>
        <form action="/buscar" role="search" className="mt-6 flex max-w-xl gap-2">
          <input name="q" type="search" className="input" placeholder="¿Qué buscas?" maxLength={100} />
          <button className="btn-primary">Buscar</button>
        </form>
      </div>
    );
  }
  return (
    <ListingView
      title={`Resultados para «${filters.q}»`}
      basePath="/buscar"
      base={{}}
      filters={filters}
      crumbs={[{ name: 'Buscar', href: '/buscar' }]}
      defaultSort="relevancia"
      dynamic
    />
  );
}
