'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/providers/ToastProvider';
import { api, isApiError, type RequestOptions } from '@/lib/api/client';
import type { TicketDetail } from '@/lib/support';

export const ticketKey = (id: string) => ['soporte', 'ticket', id] as const;

/**
 * Acción sobre un ticket (tomar, asignar, cambiar estado, responder, nota). Todas devuelven el
 * ticket completo: se guarda en caché y se invalida la cola. Ante 409 STALE_VERSION (otro agente
 * lo cambió después de que lo leíste) se recarga el ticket y se avisa; el texto escrito se conserva.
 */
export function useTicketAction<V>(ticketId: string, request: (v: V) => { path: string; method: RequestOptions['method']; body: unknown }, okText?: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (v: V) => {
      const r = request(v);
      return api<TicketDetail>(`/support/tickets/${ticketId}${r.path}`, { method: r.method, body: r.body });
    },
    onSuccess: (ticket) => {
      qc.setQueryData(ticketKey(ticketId), ticket);
      void qc.invalidateQueries({ queryKey: ['soporte', 'tickets'] });
      if (okText) toast.ok(okText);
    },
    onError: (e) => {
      if (isApiError(e, 'STALE_VERSION')) {
        toast.info('Otro agente modificó este ticket. Se recargó con los últimos cambios: revísalo y vuelve a intentarlo.');
        void qc.invalidateQueries({ queryKey: ticketKey(ticketId) });
        return;
      }
      if (isApiError(e, 'TICKET_CLOSED')) void qc.invalidateQueries({ queryKey: ticketKey(ticketId) });
      toast.error(e);
    },
  });
}
