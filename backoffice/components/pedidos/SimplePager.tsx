'use client';

/**
 * Paginación por limit/offset para listados que el API devuelve como arreglo SIN total
 * (GET /orders, GET /inventory/stock): hay página siguiente si llegó la página completa.
 */
export function SimplePager({
  count,
  limit,
  offset,
  onChange,
}: {
  count: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  const hasMore = count >= limit;
  if (offset === 0 && !hasMore) return <p className="mt-3 text-xs text-ink-soft">{count} registro(s)</p>;
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-xs text-ink-soft">
      <span>
        {count === 0 ? 'Sin registros en esta página' : `${offset + 1}–${offset + count}`}
      </span>
      <div className="flex gap-2">
        <button className="btn-ghost btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          Anterior
        </button>
        <button className="btn-ghost btn-sm" disabled={!hasMore} onClick={() => onChange(offset + limit)}>
          Siguiente
        </button>
      </div>
    </div>
  );
}
