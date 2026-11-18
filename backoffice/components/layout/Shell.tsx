'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { APP_NAME } from '@/lib/config';
import { fullName } from '@/lib/format';
import { visibleNav } from '@/lib/permissions';

/** Marco del panel: menú lateral según permisos (cajón en móvil) y barra superior con la cuenta. */
export function Shell({ children }: { children: React.ReactNode }) {
  const { user, permissions, logout } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const sections = visibleNav(permissions);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const nav = (
    // Al elegir un destino en móvil, el cajón se cierra (el clic burbujea desde el enlace).
    <nav aria-label="Menú principal" className="flex flex-col gap-5 p-4 text-sm" onClick={(e) => (e.target as HTMLElement).closest('a') && setOpen(false)}>
      <Link href="/" className={`rounded-md px-2 py-1.5 font-medium ${pathname === '/' ? 'bg-sand text-ink' : 'text-ink-soft hover:text-ink'}`}>
        Inicio
      </Link>
      {sections.map((s) => (
        <div key={s.id}>
          <p className="mb-1 px-2 text-[11px] font-semibold tracking-widest text-ink-soft/80 uppercase">{s.label}</p>
          <ul className="space-y-0.5">
            {s.items.map((i) => (
              <li key={i.href}>
                <Link
                  href={i.href}
                  aria-current={isActive(i.href) ? 'page' : undefined}
                  className={`block rounded-md px-2 py-1.5 ${isActive(i.href) ? 'bg-ink font-medium text-paper' : 'text-ink hover:bg-sand'}`}
                >
                  {i.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r border-line bg-panel lg:block">
        <div className="sticky top-0 max-h-dvh overflow-y-auto">
          <p className="border-b border-line px-6 py-4 text-sm font-semibold">{APP_NAME}</p>
          {nav}
        </div>
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menú">
          <button className="absolute inset-0 bg-ink/40" aria-label="Cerrar menú" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-panel shadow-xl">{nav}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-panel/95 px-4 py-2.5 backdrop-blur">
          <button className="btn-ghost btn-sm lg:hidden" onClick={() => setOpen(true)} aria-label="Abrir menú">
            ☰ Menú
          </button>
          <span className="truncate text-sm font-semibold lg:hidden">{APP_NAME}</span>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link href="/cuenta" className="hidden text-ink-soft hover:text-ink sm:inline">
              {fullName(user?.firstName, user?.lastName)}
              {user && !user.mfaEnabled && <span className="ml-2 rounded bg-warn/10 px-1.5 py-0.5 text-xs text-warn">sin 2FA</span>}
            </Link>
            <button className="btn-ghost btn-sm" onClick={() => void logout()}>
              Salir
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
