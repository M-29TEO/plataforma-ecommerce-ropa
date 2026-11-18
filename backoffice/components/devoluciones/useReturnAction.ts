'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/providers/ToastProvider';
import { api, isApiError } from '@/lib/api/client';
import type { ReturnDetail } from '@/lib/returns';

export const returnKey = (id: string) => ['returns', 'detail', id] as const;

/** Errores de "otro ya la movió": se recarga la devolución para mostrar su estado real. */
const STALE_CODES = ['INVALID_RETURN_TRANSITION', 'EXCHANGE_NOT_PENDING', 'STALE_VERSION'];

/**
 * Acción sobre una devolución (aprobar, rechazar, recibir, inspeccionar, reintentar el cambio).
 * Todas devuelven la devolución completa (la inspección, dentro de `return`): se guarda en caché y
 * se invalidan la cola, las devoluciones del pedido y el pedido (su estado cambia al inspeccionar).
 */
export function useReturnAction<V, R = ReturnDetail>(
  returnId: string,
  request: (v: V) => { path: string; body?: unknown },
  opts: { ok?: (res: R) => string; pick?: (res: R) => ReturnDetail } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (v: V) => {
      const r = request(v);
      return api<R>(`/returns/${returnId}${r.path}`, { method: 'POST', body: r.body ?? {} });
    },
    onSuccess: (res) => {
      const ret = opts.pick ? opts.pick(res) : (res as unknown as ReturnDetail);
      qc.setQueryData(returnKey(returnId), ret);
      void qc.invalidateQueries({ queryKey: ['returns', 'list'] });
      void qc.invalidateQueries({ queryKey: ['returns', 'order', ret.orderId] });
      void qc.invalidateQueries({ queryKey: ['orders', 'detail', ret.orderId] });
      if (opts.ok) toast.ok(opts.ok(res));
    },
    onError: (e) => {
      if (STALE_CODES.some((c) => isApiError(e, c))) void qc.invalidateQueries({ queryKey: returnKey(returnId) });
    },
  });
}
