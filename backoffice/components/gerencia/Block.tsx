'use client';

import { ErrorState } from '@/components/ui/States';
import { Spinner } from '@/components/ui/Spinner';
import { formatDateTime } from '@/lib/format';

/**
 * Marco de cada bloque del dashboard: título, controles propios y su propio estado de carga/error,
 * así un reporte que falla no tumba los demás.
 */
export function Block({
  title,
  subtitle,
  controls,
  dataAsOf,
  className = '',
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  controls?: React.ReactNode;
  dataAsOf?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`card flex min-w-0 flex-col p-4 ${className}`} aria-label={title}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          {subtitle && <p className="text-xs text-ink-soft">{subtitle}</p>}
        </div>
        {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}
      </header>
      <div className="min-w-0 flex-1">{children}</div>
      {dataAsOf !== undefined && (
        <p className="mt-3 text-[11px] text-ink-soft">{dataAsOf ? `Datos actualizados al ${formatDateTime(dataAsOf)} (se refrescan cada 15 min)` : 'Las vistas aún no se han refrescado'}</p>
      )}
    </section>
  );
}

/** Carga / error / contenido de un useQuery dentro de un bloque (altura estable mientras carga). */
export function BlockState<T>({
  query,
  height = 260,
  children,
}: {
  query: { data: T | undefined; error: unknown; isPending: boolean; refetch: () => unknown };
  height?: number;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: height }}>
        <Spinner />
      </div>
    );
  }
  if (query.error || query.data === undefined) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}

/** Selector compacto (segmentado) para cambiar métrica o agrupación de un bloque. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-line bg-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${o.value === value ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Botón "Ver tabla / Ver gráfico": cada gráfico tiene su vista de tabla (accesibilidad). */
export function TableToggle({ table, onChange }: { table: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className="btn-ghost btn-sm" aria-pressed={table} onClick={() => onChange(!table)}>
      {table ? 'Ver gráfico' : 'Ver tabla'}
    </button>
  );
}

/** Tooltip de los gráficos: título y filas etiqueta/valor con la marca de color al lado (el texto va en tinta). */
export function ChartTooltip({ title, rows }: { title: React.ReactNode; rows: { label: string; value: string; color?: string }[] }) {
  return (
    <div className="rounded-md border border-line bg-panel px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-semibold text-ink">{title}</p>
      <dl className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-4">
            <dt className="flex items-center gap-1.5 text-ink-soft">
              {r.color && <span className="inline-block h-2 w-2 rounded-full" style={{ background: r.color }} aria-hidden />}
              {r.label}
            </dt>
            <dd className="font-medium text-ink tabular-nums">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
