'use client';

import Link from 'next/link';
import { useAuth } from '@/components/providers/AuthProvider';
import { EmptyState } from '@/components/ui/States';
import { visibleNav } from '@/lib/permissions';

/** Inicio: accesos a las pantallas que el rol del usuario puede usar, agrupadas por área. */
export default function HomePage() {
  const { user, permissions } = useAuth();
  const sections = visibleNav(permissions);

  return (
    <div>
      <h1 className="text-xl font-semibold">Hola{user?.firstName ? `, ${user.firstName}` : ''}</h1>
      <p className="mt-0.5 text-sm text-ink-soft">Estas son las áreas a las que tienes acceso.</p>

      {!user?.mfaEnabled && (
        <div className="mt-4 rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-sm">
          Protege tu cuenta con verificación en dos pasos.{' '}
          <Link href="/cuenta" className="font-medium underline">
            Activar 2FA
          </Link>
        </div>
      )}

      {sections.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="Tu cuenta aún no tiene un rol del backoffice">Pide a un administrador que te asigne uno.</EmptyState>
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {sections.map((s) => (
            <section key={s.id}>
              <h2 className="mb-3 text-xs font-semibold tracking-widest text-ink-soft uppercase">{s.label}</h2>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {s.items.map((i) => (
                  <li key={i.href}>
                    <Link href={i.href} className="card block h-full p-4 transition-colors hover:border-ink">
                      <p className="font-medium">{i.label}</p>
                      <p className="mt-1 text-sm text-ink-soft">{i.description}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
