'use client';

import { useRouter } from 'next/navigation';
import { type Filters, SORTS, type SortKey, toUrlSearch } from '@/lib/filters';

export function SortSelect({ basePath, filters, defaultSort, withRelevance }: { basePath: string; filters: Filters; defaultSort: SortKey; withRelevance: boolean }) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-ink-soft">Ordenar por</span>
      <select
        className="rounded-full border border-line bg-white px-3 py-2"
        value={filters.sort}
        onChange={(e) => router.push(`${basePath}${toUrlSearch({ ...filters, sort: e.target.value as SortKey, page: 1 }, defaultSort)}`, { scroll: false })}
      >
        {SORTS.filter((s) => withRelevance || s.key !== 'relevancia').map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}
