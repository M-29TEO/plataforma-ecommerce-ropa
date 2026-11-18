'use client';

import { formatInt } from '@/lib/format';

/** Paginación por offset (los listados del API son `{ items, total }` con limit/offset). */
export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit && offset === 0) return <p className="mt-3 text-xs text-ink-soft">{formatInt(total)} registro(s)</p>;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-xs text-ink-soft">
      <span>
        {formatInt(from)}–{formatInt(to)} de {formatInt(total)}
      </span>
      <div className="flex gap-2">
        <button className="btn-ghost btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          Anterior
        </button>
        <button className="btn-ghost btn-sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
          Siguiente
        </button>
      </div>
    </div>
  );
}
