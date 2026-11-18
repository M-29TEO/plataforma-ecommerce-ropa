'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '../providers/AuthProvider';

const NAV = [
  ['/mi-cuenta', 'Resumen'],
  ['/mi-cuenta/pedidos', 'Mis pedidos'],
  ['/mi-cuenta/devoluciones', 'Devoluciones'],
  ['/mi-cuenta/direcciones', 'Direcciones'],
  ['/mi-cuenta/favoritos', 'Favoritos'],
  ['/mi-cuenta/privacidad', 'Privacidad'],
] as const;

/** Área de cliente: sin sesión redirige a /ingresar y vuelve aquí después. */
export function AccountShell({ children }: { children: React.ReactNode }) {
  const { status, user, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (status === 'guest') router.replace(`/ingresar?volver=${encodeURIComponent(pathname)}`);
  }, [status, pathname, router]);

  if (status !== 'authenticated') return <div className="container-page py-16 text-ink-soft">Cargando tu cuenta…</div>;

  return (
    <div className="container-page grid gap-8 py-10 lg:grid-cols-[220px_1fr]">
      <aside>
        <p className="font-display text-xl">Hola, {user?.firstName ?? 'cliente'}</p>
        <nav aria-label="Mi cuenta" className="mt-4">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col">
            {NAV.map(([href, label]) => {
              const active = href === '/mi-cuenta' ? pathname === href : pathname.startsWith(href);
              return (
                <li key={href}>
                  <Link href={href} aria-current={active ? 'page' : undefined} className={`block whitespace-nowrap rounded-lg px-3 py-2 text-sm ${active ? 'bg-ink text-paper' : 'hover:bg-sand'}`}>
                    {label}
                  </Link>
                </li>
              );
            })}
            <li>
              <button
                type="button"
                className="w-full rounded-lg px-3 py-2 text-left text-sm text-ink-soft hover:bg-sand"
                onClick={async () => {
                  await logout();
                  router.replace('/');
                }}
              >
                Cerrar sesión
              </button>
            </li>
          </ul>
        </nav>
      </aside>
      <section>{children}</section>
    </div>
  );
}
