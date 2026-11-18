'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '@/lib/api/client';
import { formatMoney } from '@/lib/format';
import type { Suggestions } from '@/lib/types';

/** Búsqueda con sugerencias (productos, categorías y marcas) mientras se escribe. Enter → /buscar. */
export function SearchBox() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [data, setData] = useState<Suggestions | null>(null);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) return;
    const ctrl = new AbortController();
    // Espera 200 ms sin teclear antes de consultar.
    const t = setTimeout(() => {
      api<Suggestions>(`/catalog/search/suggest?q=${encodeURIComponent(text)}`, { signal: ctrl.signal })
        .then(setData)
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setOpen(false);
    router.push(`/buscar?q=${encodeURIComponent(q.trim())}`);
  }

  const close = () => setOpen(false);
  const shown = q.trim().length >= 2 ? data : null;
  const hasResults = shown && shown.products.length + shown.categories.length + shown.brands.length > 0;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-sand" aria-label="Buscar">
        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-ink/40" onClick={close} role="presentation">
          <div className="mx-auto mt-0 max-w-2xl bg-paper p-4 shadow-xl sm:mt-16 sm:rounded-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Buscar productos">
            <form onSubmit={submit} role="search" className="flex gap-2">
              <input
                ref={inputRef}
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && close()}
                placeholder="Busca vestidos, jeans, lino…"
                className="input text-base"
                aria-controls={listId}
                aria-autocomplete="list"
                maxLength={100}
              />
              <button className="btn-primary" type="submit">
                Buscar
              </button>
            </form>
            <div id={listId} className="mt-3 max-h-[60vh] overflow-y-auto">
              {q.trim().length >= 2 && shown && !hasResults && <p className="p-3 text-sm text-ink-soft">Sin coincidencias. Prueba con otra palabra.</p>}
              {shown && shown.products.length > 0 && (
                <ul className="divide-y divide-line">
                  {shown.products.map((p) => (
                    <li key={p.slug}>
                      <Link href={`/producto/${p.slug}`} onClick={close} className="flex items-center gap-3 rounded-lg p-2 hover:bg-sand">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {p.imageUrl ? <img src={p.imageUrl} alt="" className="h-14 w-11 rounded object-cover" /> : <span className="h-14 w-11 rounded bg-sand" />}
                        <span className="flex-1 text-sm">{p.name}</span>
                        <span className="text-sm font-medium">{formatMoney(p.price)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {shown && (shown.categories.length > 0 || shown.brands.length > 0) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {shown.categories.map((c) => (
                    <Link key={c.path} href={`/categoria/${c.path}`} onClick={close} className="chip hover:border-ink">
                      {c.name}
                    </Link>
                  ))}
                  {shown.brands.map((b) => (
                    <Link key={b.slug} href={`/marca/${b.slug}`} onClick={close} className="chip hover:border-ink">
                      {b.name}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
