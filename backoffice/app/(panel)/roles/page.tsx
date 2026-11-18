'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Fragment } from 'react';
import { useCan } from '@/components/providers/AuthProvider';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryState } from '@/components/ui/States';
import { type AdminUser, allPermissions, groupPermissions, permissionLabel, ROLE_USER_TYPE, type Role, USER_TYPE_LABEL } from '@/lib/admin';
import { api } from '@/lib/api/client';
import { formatInt } from '@/lib/format';
import type { Page } from '@/lib/types';

/** Matriz roles × permisos (solo lectura: los roles del sistema se definen en el código). */
export default function RolesPage() {
  const can = useCan();
  const roles = useQuery({
    queryKey: ['iam', 'roles'],
    queryFn: ({ signal }) => api<Role[]>('/iam/roles', { signal }),
    staleTime: 5 * 60_000,
  });

  // Cuántos usuarios tiene cada rol (el total de una página de 1).
  const counts = useQueries({
    queries: (roles.data ?? []).map((r) => ({
      queryKey: ['iam', 'users', { role: r.code, limit: 1 }],
      queryFn: ({ signal }: { signal: AbortSignal }) => api<Page<AdminUser>>('/iam/users', { query: { role: r.code, limit: 1 }, signal }),
      enabled: can('iam.users.read'),
      staleTime: 60_000,
    })),
  });

  return (
    <div>
      <PageHeader title="Roles y permisos" description="Qué puede hacer cada rol en el backoffice" />

      <p className="mb-4 rounded-md border border-info/30 bg-info/5 px-3 py-2 text-sm text-info">
        Los roles del sistema son de solo lectura: sus permisos se definen en el código de la plataforma y se aplican igual en todas las
        tiendas. Para dar acceso a una persona, asígnale un rol desde su ficha en{' '}
        <Link href="/usuarios" className="underline">
          Usuarios
        </Link>
        .
      </p>

      <QueryState query={roles} loading="Cargando roles…">
        {(list) => {
          const groups = groupPermissions(allPermissions(list));
          return (
            <div className="card overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 min-w-56 bg-sand">Permiso</th>
                    {list.map((r, i) => (
                      <th key={r.code} className="text-center normal-case">
                        <div className="text-ink">{r.name}</div>
                        <div className="mt-0.5 flex flex-col items-center gap-0.5 font-normal tracking-normal">
                          <span className="font-mono text-[11px]">{r.code}</span>
                          <span className="flex gap-1">
                            {r.isSystem ? <Badge>Sistema</Badge> : <Badge tone="info">Propio</Badge>}
                          </span>
                          {ROLE_USER_TYPE[r.code] && <span className="text-[11px]">{USER_TYPE_LABEL[ROLE_USER_TYPE[r.code]]}</span>}
                          {counts[i]?.data && (
                            <Link href={`/usuarios?role=${r.code}`} className="text-[11px] underline" title="Usuarios con este rol">
                              {formatInt(counts[i].data.total)} usuario(s)
                            </Link>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <Fragment key={g.label}>
                      <tr>
                        <td colSpan={list.length + 1} className="sticky left-0 bg-paper text-xs font-semibold tracking-wide text-ink-soft uppercase">
                          {g.label}
                        </td>
                      </tr>
                      {g.permissions.map((p) => (
                        <tr key={p}>
                          <td className="sticky left-0 z-10 bg-panel">
                            <div>{permissionLabel(p)}</div>
                            <div className="font-mono text-[11px] text-ink-soft">{p}</div>
                          </td>
                          {list.map((r) => {
                            const has = r.permissions.includes(p);
                            return (
                              <td key={r.code} className="text-center">
                                {has ? (
                                  <span className="font-semibold text-ok" aria-label="Sí">
                                    ✓
                                  </span>
                                ) : (
                                  <span className="text-line" aria-label="No">
                                    ·
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  <tr>
                    <td className="sticky left-0 z-10 bg-panel font-medium">Total de permisos</td>
                    {list.map((r) => (
                      <td key={r.code} className="num text-center font-medium">
                        {r.permissions.length || <span className="text-xs font-normal text-ink-soft">Sin acceso al backoffice</span>}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
