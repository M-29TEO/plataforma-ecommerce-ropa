import Link from 'next/link';
import { type Filters, PAGE_SIZE, type SortKey, toUrlSearch } from '@/lib/filters';

/** Enlaces reales (no botones): los buscadores siguen las páginas del listado. */
export function Pagination({ basePath, filters, total, defaultSort }: { basePath: string; filters: Filters; total: number; defaultSort: SortKey }) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;
  const href = (page: number) => `${basePath}${toUrlSearch({ ...filters, page }, defaultSort)}`;
  const current = filters.page;
  const window = [...new Set([1, current - 1, current, current + 1, pages])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  return (
    <nav aria-label="Páginas" className="mt-10 flex items-center justify-center gap-1">
      {current > 1 && (
        <Link className="btn-ghost px-3" href={href(current - 1)} rel="prev">
          Anterior
        </Link>
      )}
      {window.map((p, i) => (
        <span key={p} className="flex items-center">
          {i > 0 && p - window[i - 1] > 1 && <span className="px-1 text-ink-soft">…</span>}
          <Link
            href={href(p)}
            aria-current={p === current ? 'page' : undefined}
            className={`h-9 min-w-9 rounded-full px-3 py-2 text-center text-sm ${p === current ? 'bg-ink text-paper' : 'hover:bg-sand'}`}
          >
            {p}
          </Link>
        </span>
      ))}
      {current < pages && (
        <Link className="btn-ghost px-3" href={href(current + 1)} rel="next">
          Siguiente
        </Link>
      )}
    </nav>
  );
}
