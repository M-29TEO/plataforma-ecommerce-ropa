'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ExportForm } from '@/components/gerencia/ExportForm';
import { useToast } from '@/components/providers/ToastProvider';
import { StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, QueryState } from '@/components/ui/States';
import { Spinner } from '@/components/ui/Spinner';
import { api, apiBlob, isApiError, saveBlob } from '@/lib/api/client';
import { formatDate, formatDateTime, formatInt, formatRelative } from '@/lib/format';
import {
  canDownload,
  EXPORT_FORMAT_LABELS,
  EXPORT_STATUS,
  exportFilename,
  formatBytes,
  GROUP_LABELS,
  hasActiveExports,
  REPORT_TITLES,
  type ExportJob,
} from '@/lib/reports';

/** Mientras haya exportes en cola o generándose, el listado se vuelve a pedir cada 3 s. */
const POLL_MS = 3000;

/** Exportes Excel/PDF del usuario: se piden aquí, el worker los genera y se descargan cuando están listos. */
export default function ExportsPage() {
  const toast = useToast();
  const [downloading, setDownloading] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['reports', 'exports'],
    queryFn: ({ signal }) => api<ExportJob[]>('/reports/exports', { query: { limit: 50 }, signal }),
    refetchInterval: (query) => (hasActiveExports(query.state.data) ? POLL_MS : false),
  });

  async function download(job: ExportJob) {
    setDownloading(job.id);
    try {
      const { blob, filename } = await apiBlob(`/reports/exports/${job.id}/download`);
      saveBlob(blob, filename ?? exportFilename(job));
    } catch (e) {
      if (isApiError(e, 'EXPORT_NOT_READY') || isApiError(e, 'EXPORT_EXPIRED')) void list.refetch();
      toast.error(e);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div>
      <PageHeader title="Exportes" description="Reportes en Excel o PDF generados en segundo plano. Solo ves los que pediste tú." back={{ href: '/gerencia', label: 'Dashboard' }} />

      <section className="card p-4">
        <h2 className="mb-3 font-semibold">Solicitar exporte</h2>
        <ExportForm />
      </section>

      <section className="mt-6">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="font-semibold">Mis exportes</h2>
          {hasActiveExports(list.data) && <Spinner label="Generando… se actualiza solo" />}
        </div>
        <QueryState query={list}>
          {(jobs) =>
            jobs.length === 0 ? (
              <EmptyState title="Aún no has pedido exportes">Elige un reporte arriba y se generará en unos segundos.</EmptyState>
            ) : (
              <div className="card overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Reporte</th>
                      <th>Rango</th>
                      <th>Formato</th>
                      <th>Estado</th>
                      <th>Solicitado</th>
                      <th className="num">Filas</th>
                      <th className="num">Tamaño</th>
                      <th>Disponible hasta</th>
                      <th className="sr-only">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((j) => {
                      const expired = j.status === 'done' && !canDownload(j);
                      return (
                        <tr key={j.id}>
                          <td>
                            <p className="font-medium">{REPORT_TITLES[j.report] ?? j.report}</p>
                            <p className="text-xs text-ink-soft">Por {(GROUP_LABELS[j.params.groupBy] ?? j.params.groupBy).toLowerCase()}</p>
                          </td>
                          <td className="whitespace-nowrap text-xs">
                            {formatDate(`${j.params.from}T12:00:00Z`)} – {formatDate(`${j.params.to}T12:00:00Z`)}
                          </td>
                          <td>{EXPORT_FORMAT_LABELS[j.format] ?? j.format}</td>
                          <td>
                            {expired ? <StatusBadge status="expired" map={{ expired: ['Vencido', 'neutral'] }} /> : <StatusBadge status={j.status} map={EXPORT_STATUS} />}
                            {j.status === 'failed' && j.error && <p className="mt-1 max-w-56 text-xs text-danger">{j.error}</p>}
                          </td>
                          <td className="whitespace-nowrap text-xs" title={formatDateTime(j.createdAt)}>
                            {formatRelative(j.createdAt)}
                          </td>
                          <td className="num">{formatInt(j.rowCount)}</td>
                          <td className="num">{formatBytes(j.sizeBytes)}</td>
                          <td className="whitespace-nowrap text-xs">{j.expiresAt ? formatDateTime(j.expiresAt) : '—'}</td>
                          <td className="text-right">
                            {canDownload(j) ? (
                              <button className="btn-ghost btn-sm" onClick={() => void download(j)} disabled={downloading === j.id}>
                                {downloading === j.id ? 'Descargando…' : 'Descargar'}
                              </button>
                            ) : j.status === 'failed' || expired ? (
                              <span className="text-xs text-ink-soft">Solicítalo de nuevo</span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          }
        </QueryState>
      </section>
    </div>
  );
}
