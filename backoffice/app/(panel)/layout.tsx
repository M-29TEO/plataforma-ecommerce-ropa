'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Shell } from '@/components/layout/Shell';
import { useAuth } from '@/components/providers/AuthProvider';
import { Forbidden } from '@/components/ui/Forbidden';
import { Spinner } from '@/components/ui/Spinner';
import { canAccess } from '@/lib/permissions';

/**
 * Todas las pantallas del panel: exigen sesión de staff y el permiso de la ruta (lib/permissions.ts).
 * Sin sesión → /ingresar?next=<ruta>. Con sesión pero sin permiso → aviso 403 (sin pedir datos al API).
 */
export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const { status, permissions } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (status === 'guest') router.replace(`/ingresar?next=${encodeURIComponent(pathname)}`);
  }, [status, pathname, router]);

  if (status !== 'authenticated') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="Cargando sesión…" />
      </div>
    );
  }

  return <Shell>{canAccess(pathname, permissions) ? children : <Forbidden />}</Shell>;
}
