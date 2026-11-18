'use client';

import { useQueries } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api } from '@/lib/api/client';
import { missingIdBatches, normalizeBarcode, type VariantLookupItem } from '@/lib/scanner';

/**
 * Caché de variantes identificadas: por escaneo o búsqueda, y por lotes de ids (useResolveVariants)
 * para nombrar lo que muestra Inventario (stock, movimientos, órdenes de compra), que solo trae
 * variantId. Se guarda en sessionStorage para sobrevivir a una recarga.
 */

const STORAGE_KEY = 'bo.variants.v1';
const MAX_ENTRIES = 2000;

let cache: Map<string, VariantLookupItem> | null = null;
const listeners = new Set<() => void>();
let version = 0;

function load(): Map<string, VariantLookupItem> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null;
    if (raw) for (const v of JSON.parse(raw) as VariantLookupItem[]) cache.set(v.variantId, v);
  } catch {
    // Almacenamiento bloqueado o datos corruptos: se empieza vacío.
  }
  return cache;
}

function persist(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...load().values()].slice(-MAX_ENTRIES)));
  } catch {
    // Sin almacenamiento: la caché vive solo en memoria.
  }
}

export function rememberVariants(items: VariantLookupItem[]): void {
  if (items.length === 0) return;
  const c = load();
  for (const v of items) c.set(v.variantId, v);
  version++;
  persist();
  for (const l of listeners) l();
}

export function cachedVariant(variantId: string): VariantLookupItem | undefined {
  return load().get(variantId);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Re-renderiza cuando se identifica una variante nueva; devuelve un getter. */
export function useVariantCache(): (variantId: string) => VariantLookupItem | undefined {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return cachedVariant;
}

/**
 * Ids ya pedidos por lote que el catálogo no devolvió (borrados u otro tenant): no se vuelven a pedir
 * en la sesión, así un id huérfano no deja una consulta en bucle.
 */
const notFound = new Set<string>();

/**
 * Pide por lotes (≤ 100 por llamada, GET /catalog/variants/lookup?ids=) los nombres de las variantes
 * que muestra una pantalla y aún no están en la caché. Los componentes leen el resultado con
 * useVariantCache / VariantName.
 */
export function useResolveVariants(variantIds: readonly string[]): void {
  const known = useVariantCache();
  const batches = missingIdBatches(variantIds, (id) => Boolean(known(id)) || notFound.has(id));
  useQueries({
    queries: batches.map((ids) => ({
      queryKey: ['catalog', 'variants', 'by-ids', ids],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const rows = await api<VariantLookupItem[]>('/catalog/variants/lookup', { query: { ids }, signal });
        const found = new Set(rows.map((r) => r.variantId));
        for (const id of ids) if (!found.has(id)) notFound.add(id);
        rememberVariants(rows);
        if (rows.length === 0) {
          // Nada nuevo en la caché, pero sí en notFound: se avisa para recalcular los lotes.
          version++;
          for (const l of listeners) l();
        }
        return ids.length;
      },
      staleTime: Infinity,
      retry: 1,
    })),
  });
}

/** Código escaneado → variante (0 o 1). Recuerda el resultado en la caché. */
export async function lookupByBarcode(code: string, signal?: AbortSignal): Promise<VariantLookupItem | null> {
  const barcode = normalizeBarcode(code);
  if (!barcode) return null;
  // Escanear varias unidades iguales seguidas no repite la consulta.
  for (const v of load().values()) if (v.barcode === barcode) return v;
  const rows = await api<VariantLookupItem[]>('/catalog/variants/lookup', { query: { barcode }, signal });
  rememberVariants(rows);
  return rows[0] ?? null;
}

/** Texto (SKU, código o nombre; mínimo 2 caracteres) → hasta 20 variantes. */
export async function searchVariants(q: string, signal?: AbortSignal): Promise<VariantLookupItem[]> {
  const text = q.trim();
  if (text.length < 2) return [];
  const rows = await api<VariantLookupItem[]>('/catalog/variants/lookup', { query: { q: text }, signal });
  rememberVariants(rows);
  return rows;
}

/**
 * Lo que entra por el escáner o el teclado: primero como código de barras exacto; si no existe,
 * como SKU (un QR o Code 128 puede llevar el SKU). Devuelve la variante si hay una sola
 * coincidencia exacta, o la lista para elegir.
 */
export async function resolveCode(code: string): Promise<{ match: VariantLookupItem | null; options: VariantLookupItem[] }> {
  const byBarcode = await lookupByBarcode(code);
  if (byBarcode) return { match: byBarcode, options: [byBarcode] };
  const text = normalizeBarcode(code);
  if (text.length < 2) return { match: null, options: [] };
  const options = await searchVariants(text);
  const exact = options.filter((v) => v.sku.toLowerCase() === text.toLowerCase());
  return { match: exact.length === 1 ? exact[0] : null, options };
}
