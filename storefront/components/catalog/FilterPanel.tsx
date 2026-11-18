'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { clearFilters, type Filters, GENDERS, hasActiveFilters, type SortKey, toggle, toUrlSearch } from '@/lib/filters';
import { formatMoney } from '@/lib/format';
import type { Facets } from '@/lib/types';

/**
 * Filtros por talla, color, precio y marca (y género). Cada cambio navega a la URL con los filtros:
 * el listado se vuelve a pedir en el servidor (SSR) y el enlace se puede compartir.
 */
export function FilterPanel({
  basePath,
  filters,
  facets,
  defaultSort,
  hideBrand,
  hideSale,
}: {
  basePath: string;
  filters: Filters;
  facets: Facets;
  defaultSort: SortKey;
  hideBrand: boolean;
  hideSale: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [min, setMin] = useState(filters.minPrice?.toString() ?? '');
  const [max, setMax] = useState(filters.maxPrice?.toString() ?? '');

  const go = (f: Filters) => start(() => router.push(`${basePath}${toUrlSearch(f, defaultSort)}`, { scroll: false }));
  const active = hasActiveFilters(filters);
  const genderLabel = (api: string) => GENDERS.find((g) => g.api === api);

  const panel = (
    <div className={`space-y-7 ${pending ? 'opacity-60' : ''}`} aria-busy={pending}>
      {active && (
        <button type="button" className="text-sm underline" onClick={() => go(clearFilters(filters))}>
          Quitar filtros
        </button>
      )}

      {facets.sizes.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Talla</legend>
          <div className="flex flex-wrap gap-2">
            {facets.sizes.map((s) => {
              const on = filters.sizes.includes(s.value);
              return (
                <button
                  key={s.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => go(toggle(filters, 'sizes', s.value))}
                  className={`min-w-11 rounded-lg border px-2 py-1.5 text-sm ${on ? 'border-ink bg-ink text-paper' : 'border-line bg-white hover:border-ink'}`}
                >
                  {s.label}
                  <span className="sr-only"> ({s.count} productos)</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      {facets.colors.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Color</legend>
          <ul className="space-y-1.5">
            {facets.colors.map((c) => {
              const on = filters.colors.includes(c.value);
              return (
                <li key={c.value}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="checkbox" checked={on} onChange={() => go(toggle(filters, 'colors', c.value))} className="sr-only peer" />
                    <span
                      className="h-5 w-5 rounded-full border border-line ring-offset-2 peer-checked:ring-2 peer-checked:ring-ink peer-focus-visible:ring-2 peer-focus-visible:ring-accent"
                      style={{ background: c.hex ?? '#ccc' }}
                      aria-hidden
                    />
                    <span className={on ? 'font-medium' : ''}>{c.label}</span>
                    <span className="ml-auto text-xs text-ink-soft">{c.count}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Precio</legend>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Math.max(0, Number(v)));
            go({ ...filters, minPrice: n(min), maxPrice: n(max), page: 1 });
          }}
        >
          <input aria-label="Precio mínimo" inputMode="decimal" className="input w-20 px-2" placeholder={facets.price.min ? `${Math.floor(Number(facets.price.min))}` : 'Mín'} value={min} onChange={(e) => setMin(e.target.value)} />
          <span aria-hidden>–</span>
          <input aria-label="Precio máximo" inputMode="decimal" className="input w-20 px-2" placeholder={facets.price.max ? `${Math.ceil(Number(facets.price.max))}` : 'Máx'} value={max} onChange={(e) => setMax(e.target.value)} />
          <button className="btn-ghost px-3 py-2" type="submit" aria-label="Aplicar precio">
            →
          </button>
        </form>
        {facets.price.min && facets.price.max && (
          <p className="mt-1 text-xs text-ink-soft">
            De {formatMoney(facets.price.min)} a {formatMoney(facets.price.max)}
          </p>
        )}
      </fieldset>

      {!hideBrand && facets.brands.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Marca</legend>
          <ul className="space-y-1.5">
            {facets.brands.map((b) => (
              <li key={b.value}>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-ink" checked={filters.brands.includes(b.value)} onChange={() => go(toggle(filters, 'brands', b.value))} />
                  <span>{b.label}</span>
                  <span className="ml-auto text-xs text-ink-soft">{b.count}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      {facets.genders.length > 1 && (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Para</legend>
          <ul className="space-y-1.5">
            {facets.genders.map((g) => {
              const key = genderLabel(g.value)?.key ?? g.value;
              return (
                <li key={g.value}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-ink" checked={filters.genders.includes(key)} onChange={() => go(toggle(filters, 'genders', key))} />
                    <span>{g.label}</span>
                    <span className="ml-auto text-xs text-ink-soft">{g.count}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      {!hideSale && (
        <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
          <input type="checkbox" className="h-4 w-4 accent-ink" checked={filters.onSale} onChange={() => go({ ...filters, onSale: !filters.onSale, page: 1 })} />
          Solo ofertas
        </label>
      )}
    </div>
  );

  return (
    <aside aria-label="Filtros">
      <button type="button" className="btn-ghost w-full lg:hidden" onClick={() => setMobileOpen((v) => !v)} aria-expanded={mobileOpen}>
        Filtros {active ? '•' : ''}
      </button>
      <div className={`${mobileOpen ? 'mt-4 block' : 'hidden'} lg:block`}>{panel}</div>
    </aside>
  );
}
