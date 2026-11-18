'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useToast } from '@/components/providers/ToastProvider';
import { StatusBadge } from '@/components/ui/Badge';
import { api, apiBlob, errorMessage, saveBlob } from '@/lib/api/client';
import { formatDate, formatMoney } from '@/lib/format';
import { creditNoteFor, DOCUMENT_STATUS, type ElectronicDocument } from '@/lib/returns';

/**
 * Archivos de un comprobante: el RIDE (PDF) se abre en otra pestaña y el XML firmado se descarga.
 * Se piden con el token (GET /billing/documents/:id/ride.pdf · /xml), así que van como blob; la
 * pestaña del PDF se abre dentro del clic para que el navegador no la bloquee.
 */
export function DocumentFiles({ doc }: { doc: Pick<ElectronicDocument, 'id' | 'number' | 'docType' | 'files'> }) {
  const toast = useToast();
  const prefix = doc.docType === '04' ? 'nota-credito' : 'factura';
  const download = useMutation({
    mutationFn: async ({ kind, win }: { kind: 'ride' | 'xml'; win: Window | null }) => {
      try {
        const { blob, filename } = await apiBlob(`/billing/documents/${doc.id}/${kind === 'ride' ? 'ride.pdf' : 'xml'}`);
        if (win) {
          const url = URL.createObjectURL(blob);
          win.location.href = url;
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } else saveBlob(blob, filename ?? `${prefix}-${doc.number}.${kind === 'ride' ? 'pdf' : 'xml'}`);
      } catch (e) {
        win?.close();
        throw e;
      }
    },
    onError: (e) => toast.error(errorMessage(e) || 'No se pudo descargar el archivo'),
  });
  return (
    <span className="inline-flex flex-wrap gap-2">
      <button className="btn-ghost btn-sm" disabled={!doc.files.ride || download.isPending} onClick={() => download.mutate({ kind: 'ride', win: window.open('', '_blank') })} title={doc.files.ride ? 'Abrir el RIDE en PDF' : 'El RIDE aún no se genera'}>
        RIDE (PDF)
      </button>
      <button className="btn-ghost btn-sm" disabled={!doc.files.xml || download.isPending} onClick={() => download.mutate({ kind: 'xml', win: null })} title={doc.files.xml ? 'Descargar el XML firmado' : 'El XML aún no se genera'}>
        XML
      </button>
    </span>
  );
}

/**
 * Nota de crédito (comprobante 04) que Facturación emite cuando el reembolso se completa
 * (evento RefundSucceeded): GET /billing/documents?returnId=&docType=04. Requiere billing.read.
 */
export function CreditNote({ returnId }: { returnId: string }) {
  const q = useQuery({
    queryKey: ['billing', 'documents', { returnId, docType: '04' }],
    queryFn: ({ signal }) => api<ElectronicDocument[]>('/billing/documents', { query: { returnId, docType: '04', limit: 10 }, signal }),
  });
  if (q.isPending) return <p className="text-sm text-ink-soft">Buscando la nota de crédito…</p>;
  if (q.error) return <p className="text-sm text-danger">{errorMessage(q.error) || 'No se pudo consultar la nota de crédito.'}</p>;
  const doc = creditNoteFor(q.data, returnId);
  if (!doc) return <p className="text-sm text-ink-soft">Aún no hay nota de crédito: se emite cuando el reembolso se completa.</p>;
  return (
    <div className="space-y-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-mono">{doc.number}</span>
        <StatusBadge status={doc.status} map={DOCUMENT_STATUS} />
      </p>
      <p className="text-ink-soft">
        {formatDate(doc.issueDate)} · {formatMoney(doc.totals.total)}
        {doc.authorizationNumber && <span className="block break-all text-xs">Autorización: {doc.authorizationNumber}</span>}
      </p>
      <DocumentFiles doc={doc} />
    </div>
  );
}

/**
 * Comprobantes del pedido (GET /billing/documents?orderId=): la factura y las notas de crédito de
 * sus devoluciones, con su estado ante el SRI y los archivos. Requiere billing.read.
 */
export function OrderDocuments({ orderId }: { orderId: string }) {
  const q = useQuery({
    queryKey: ['billing', 'documents', { orderId }],
    queryFn: ({ signal }) => api<ElectronicDocument[]>('/billing/documents', { query: { orderId, limit: 50 }, signal }),
  });
  if (q.isPending) return <p className="text-sm text-ink-soft">Cargando comprobantes…</p>;
  if (q.error) return <p className="text-sm text-danger">{errorMessage(q.error) || 'No se pudieron cargar los comprobantes.'}</p>;
  if (q.data.length === 0) return <p className="text-sm text-ink-soft">Aún no hay comprobantes electrónicos.</p>;
  return (
    <ul className="space-y-3 text-sm">
      {q.data.map((d) => (
        <li key={d.id} className="space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{d.docType === '04' ? 'Nota de crédito' : 'Factura'}</span>
            <span className="font-mono text-xs">{d.number}</span>
            <StatusBadge status={d.status} map={DOCUMENT_STATUS} />
          </p>
          <p className="text-xs text-ink-soft">
            {formatDate(d.issueDate)} · {formatMoney(d.totals.total)}
          </p>
          <DocumentFiles doc={d} />
        </li>
      ))}
    </ul>
  );
}
