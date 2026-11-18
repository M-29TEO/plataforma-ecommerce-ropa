'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useId } from 'react';
import { useVariantCache } from '@/components/scanner/variant-cache';
import { api } from '@/lib/api/client';
import { shortId, type Supplier, type Warehouse, warehouseLabel } from '@/lib/inventory';
import { variantLabel } from '@/lib/scanner';

/** Bodegas activas (GET /inventory/warehouses?active=true). Cambian poco: 5 min de caché. */
export function useWarehouses() {
  return useQuery({
    queryKey: ['inventory', 'warehouses', { active: true }],
    queryFn: ({ signal }) => api<Warehouse[]>('/inventory/warehouses', { query: { active: true }, signal }),
    staleTime: 5 * 60_000,
  });
}

export function useSuppliers(enabled = true) {
  return useQuery({
    queryKey: ['inventory', 'suppliers'],
    queryFn: ({ signal }) => api<Supplier[]>('/inventory/suppliers', { signal }),
    staleTime: 5 * 60_000,
    enabled,
  });
}

const WAREHOUSE_KEY = 'bo.bodega.warehouse';

/** Bodega recordada entre pantallas (la de trabajo del usuario). */
export function rememberedWarehouse(): string {
  try {
    return localStorage.getItem(WAREHOUSE_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberWarehouse(id: string): void {
  try {
    localStorage.setItem(WAREHOUSE_KEY, id);
  } catch {
    // Sin almacenamiento.
  }
}

/**
 * Selector de bodega. Si el valor está vacío (o ya no existe) y `autoSelect`, elige la recordada o
 * la primera, para que el bodeguero no tenga que elegir cada vez.
 */
export function WarehouseSelect({
  value,
  onChange,
  label = 'Bodega',
  autoSelect = true,
  allowEmpty = false,
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
  autoSelect?: boolean;
  allowEmpty?: boolean;
}) {
  const id = useId();
  const q = useWarehouses();
  const list = q.data;

  useEffect(() => {
    if (!autoSelect || !list || list.length === 0) return;
    if (value && list.some((w) => w.id === value)) return;
    const saved = rememberedWarehouse();
    onChange(list.some((w) => w.id === saved) ? saved : list[0].id);
  }, [autoSelect, list, value, onChange]);

  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select
        id={id}
        className="input"
        value={value}
        onChange={(e) => {
          rememberWarehouse(e.target.value);
          onChange(e.target.value);
        }}
        disabled={q.isPending}
      >
        {(allowEmpty || !value) && <option value="">{q.isPending ? 'Cargando…' : allowEmpty ? 'Todas' : 'Elige una bodega'}</option>}
        {list?.map((w) => (
          <option key={w.id} value={w.id}>
            {warehouseLabel(w)}
          </option>
        ))}
      </select>
      {q.error ? <p className="mt-1 text-xs text-danger">No se pudieron cargar las bodegas</p> : null}
    </div>
  );
}

/** Nombre de bodega por id (usa la lista cacheada). */
export function useWarehouseName(): (id: string | null | undefined) => string {
  const q = useWarehouses();
  return (id) => {
    if (!id) return '—';
    return warehouseLabel(q.data?.find((w) => w.id === id), id);
  };
}

/**
 * Variante por id: nombre, color, talla y SKU desde la caché (la llena useResolveVariants por lotes,
 * o un escaneo / búsqueda). Mientras carga, o si el catálogo no la conoce, un id corto.
 */
export function VariantName({ variantId, compact = false }: { variantId: string; compact?: boolean }) {
  const get = useVariantCache();
  const v = get(variantId);
  if (!v) {
    return (
      <span className="font-mono text-xs text-ink-soft" title={variantId}>
        Variante {shortId(variantId)}
      </span>
    );
  }
  return (
    <span className="block min-w-0">
      <span className="block truncate font-medium">{variantLabel(v)}</span>
      {!compact && (
        <span className="block font-mono text-xs text-ink-soft">
          {v.sku}
          {v.barcode ? ` · ${v.barcode}` : ''}
        </span>
      )}
    </span>
  );
}
