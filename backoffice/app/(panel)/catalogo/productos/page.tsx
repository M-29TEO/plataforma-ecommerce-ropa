'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useLookups } from '@/components/catalogo/hooks';
import { StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { EmptyState, QueryState } from '@/components/ui/States';
import { api } from '@/lib/api/client';
import { type AdminProductListItem, categoryOptions, GENDER_LABEL, PRODUCT_STATUS, PRODUCT_STATUSES, type ProductStatus } from '@/lib/catalog';
import { formatInt, formatMoney, formatRelative } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import type { Page } from '@/lib/types';

const LIMIT = 25;

interface Filters {
  q: string;
  status: ProductStatus | '';
  categoryId: string;
  brandId: string;
}

/** Productos: búsqueda (nombre, slug, SKU o código de barras), filtros y paginación. */
export default function ProductsPage() {
  const [filters, setFilters] = useState<Filters>({ q: '', status: '', categoryId: '', brandId: '' });
  const [offset, setOffset] = useState(0);
  const q = useDebounced(filters.q.trim(), 350);
  const lookups = useLookups();

  const query = { q: q || undefined, status: filters.status, categoryId: filters.categoryId, brandId: filters.brandId, limit: LIMIT, offset };
  const products = useQuery({
    queryKey: ['catalog', 'products', query],
    queryFn: ({ signal }) => api<Page<AdminProductListItem>>('/catalog/admin/products', { query, signal }),
    placeholderData: keepPreviousData,
  });

  const update = <K extends keyof Filters>(k: K, v: Filters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setOffset(0);
  };

  return (
    <div>
      <PageHeader
        title="Productos"
        description="Catálogo de la tienda: productos, variantes, precios y fotos"
        actions={
          <>
            <Link href="/catalogo/precios" className="btn-ghost">Precios masivos</Link>
            <Link href="/catalogo/productos/nuevo" className="btn-primary">Nuevo producto</Link>
          </>
        }
      />

      <div className="card mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="f-q">Buscar</label>
          <input
            id="f-q"
            type="search"
            className="input"
            placeholder="Nombre, slug, SKU o código de barras"
            maxLength={100}
            value={filters.q}
            onChange={(e) => update('q', e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="f-status">Estado</label>
          <select id="f-status" className="input" value={filters.status} onChange={(e) => update('status', e.target.value as Filters['status'])}>
            <option value="">Todos</option>
            {PRODUCT_STATUSES.map((s) => (
              <option key={s} value={s}>{PRODUCT_STATUS[s][0]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-cat">Categoría</label>
          <select id="f-cat" className="input" value={filters.categoryId} onChange={(e) => update('categoryId', e.target.value)}>
            <option value="">Todas</option>
            {categoryOptions(lookups.data?.categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-brand">Marca</label>
          <select id="f-brand" className="input" value={filters.brandId} onChange={(e) => update('brandId', e.target.value)}>
            <option value="">Todas</option>
            {(lookups.data?.brands ?? []).map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      </div>

      <QueryState query={products} loading="Cargando productos…">
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title="No hay productos con esos filtros">
              <Link href="/catalogo/productos/nuevo" className="text-accent hover:underline">Crear un producto</Link>
            </EmptyState>
          ) : (
            <>
              <div className={`card overflow-x-auto ${products.isPlaceholderData ? 'opacity-60' : ''}`}>
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th>Categoría</th>
                      <th>Marca</th>
                      <th>Género</th>
                      <th className="num">Precio</th>
                      <th className="num">Variantes</th>
                      <th>Estado</th>
                      <th>Actualizado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link href={`/catalogo/productos/${p.id}`} prefetch={false} className="font-medium hover:text-accent">{p.name}</Link>
                          <div className="font-mono text-xs text-ink-soft">{p.slug}</div>
                        </td>
                        <td>{p.category.name}</td>
                        <td>{p.brand?.name ?? <span className="text-ink-soft">—</span>}</td>
                        <td>{GENDER_LABEL[p.gender] ?? p.gender}</td>
                        <td className="num whitespace-nowrap">
                          {p.compareAtPrice != null && <span className="mr-1.5 text-xs text-ink-soft line-through">{formatMoney(p.compareAtPrice)}</span>}
                          {formatMoney(p.basePrice)}
                        </td>
                        <td className="num">{formatInt(p.variantCount)}</td>
                        <td><StatusBadge status={p.status} map={PRODUCT_STATUS} /></td>
                        <td className="whitespace-nowrap text-ink-soft">{formatRelative(p.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination total={page.total} limit={LIMIT} offset={offset} onChange={setOffset} />
            </>
          )
        }
      </QueryState>
    </div>
  );
}
