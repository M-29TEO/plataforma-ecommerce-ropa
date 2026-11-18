'use client';

import { errorMessage } from '@/lib/api/client';
import { Spinner } from './Spinner';

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-ink-soft">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger" role="alert">
      {errorMessage(error) || 'No se pudo cargar.'}
      {onRetry && (
        <button className="ml-3 underline" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </div>
  );
}

/**
 * Envoltorio para el resultado de un useQuery: muestra carga, error o el contenido.
 * Uso: <QueryState query={q}>{(data) => ...}</QueryState>
 */
export function QueryState<T>({
  query,
  children,
  loading = 'Cargando…',
}: {
  query: { data: T | undefined; error: unknown; isPending: boolean; refetch: () => unknown };
  children: (data: T) => React.ReactNode;
  loading?: string;
}) {
  if (query.isPending) return <div className="py-8"><Spinner label={loading} /></div>;
  if (query.error || query.data === undefined) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}
