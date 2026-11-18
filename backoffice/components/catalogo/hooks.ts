'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api/client';
import type { AdminProductDetail, Lookups } from '@/lib/catalog';

export const LOOKUPS_KEY = ['catalog', 'lookups'] as const;
export const productKey = (id: string) => ['catalog', 'product', id] as const;

/** Marcas, categorías, colores, tallas y guías de tallas (cambian poco: 5 min en caché). */
export function useLookups() {
  return useQuery({
    queryKey: LOOKUPS_KEY,
    queryFn: ({ signal }) => api<Lookups>('/catalog/admin/lookups', { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useProduct(id: string, enabled = true) {
  return useQuery({
    queryKey: productKey(id),
    queryFn: ({ signal }) => api<AdminProductDetail>(`/catalog/admin/products/${id}`, { signal }),
    enabled,
  });
}

/**
 * Aviso al salir con cambios sin guardar: beforeunload (cerrar pestaña, recargar) y clics en
 * enlaces internos (la navegación del App Router no dispara beforeunload).
 */
export function useUnsavedChangesWarning(active: boolean, message = 'Tienes cambios sin guardar. ¿Salir de todos modos?') {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [active, message]);
}
