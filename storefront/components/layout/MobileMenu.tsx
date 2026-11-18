'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { NavGroup } from './Header';

export function MobileMenu({ groups }: { groups: NavGroup[] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-sand lg:hidden" onClick={() => setOpen(true)} aria-label="Abrir menú">
        <svg viewBox="0 0 24 24" className="h-5 w-5 stroke-current" strokeWidth="1.8" aria-hidden>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-ink/40 lg:hidden" onClick={() => setOpen(false)} role="presentation">
          <nav aria-label="Menú" className="h-full w-80 max-w-[85vw] overflow-y-auto bg-paper p-5" onClick={(e) => {
            e.stopPropagation();
            // Tocar un enlace cierra el menú.
            if ((e.target as HTMLElement).closest('a')) setOpen(false);
          }}>
            <button type="button" onClick={() => setOpen(false)} className="mb-4 text-sm text-ink-soft">
              Cerrar ✕
            </button>
            <ul className="space-y-5">
              {groups.map((g) => (
                <li key={g.path}>
                  <Link href={`/categoria/${g.path}`} className="font-display text-lg">
                    {g.name}
                  </Link>
                  <ul className="mt-2 space-y-1 border-l border-line pl-3">
                    {g.children.map((c) => (
                      <li key={c.path}>
                        <Link href={`/categoria/${c.path}`} className="block py-1 text-sm">
                          {c.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
              <li>
                <Link href="/ofertas" className="font-display text-lg text-accent-dark">
                  Ofertas
                </Link>
              </li>
              <li>
                <Link href="/mi-cuenta/pedidos" className="text-sm">
                  Mis pedidos
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      )}
    </>
  );
}
