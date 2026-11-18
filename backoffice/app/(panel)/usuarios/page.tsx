'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CreateStaffUserModal } from '@/components/admin/CreateStaffUserModal';
import { TemporaryPasswordModal } from '@/components/admin/TemporaryPasswordModal';
import { useCan } from '@/components/providers/AuthProvider';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { EmptyState, QueryState } from '@/components/ui/States';
import { type AdminUser, type CreatedStaffUser, requiresMfa, type Role, USER_STATUS, USER_TYPE_LABEL, type UserFilters } from '@/lib/admin';
import { api } from '@/lib/api/client';
import { formatDateTime, fullName } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import type { Page } from '@/lib/types';

const LIMIT = 20;

/** Usuarios: personal, clientes y motorizados con búsqueda, filtros y alta de personal. */
export default function UsersPage() {
  // useSearchParams exige un límite de Suspense al prerenderizar.
  return (
    <Suspense>
      <UsersList />
    </Suspense>
  );
}

function UsersList() {
  const can = useCan();
  const params = useSearchParams();
  const [filters, setFilters] = useState<UserFilters>(() => ({ q: '', type: '', status: '', role: params.get('role') ?? '' }));
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedStaffUser | null>(null);
  const q = useDebounced(filters.q.trim(), 350);

  const query = { q: q || undefined, type: filters.type, status: filters.status, role: filters.role, limit: LIMIT, offset };
  const users = useQuery({
    queryKey: ['iam', 'users', query],
    queryFn: ({ signal }) => api<Page<AdminUser>>('/iam/users', { query, signal }),
    placeholderData: keepPreviousData,
  });

  const roles = useQuery({
    queryKey: ['iam', 'roles'],
    queryFn: ({ signal }) => api<Role[]>('/iam/roles', { signal }),
    enabled: can('iam.roles.read'),
    staleTime: 5 * 60_000,
  });
  const roleName = (code: string) => roles.data?.find((r) => r.code === code)?.name ?? code;

  const update = <K extends keyof UserFilters>(k: K, v: UserFilters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setOffset(0);
  };

  const canCreate = can('iam.users.write') && can('iam.roles.assign') && can('iam.roles.read');

  return (
    <div>
      <PageHeader
        title="Usuarios"
        description="Personal, clientes y motorizados de la tienda"
        actions={
          canCreate && (
            <button className="btn-primary" onClick={() => setCreating(true)}>
              Nuevo usuario
            </button>
          )
        }
      />

      <div className="card mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="f-q">Buscar</label>
          <input
            id="f-q"
            type="search"
            className="input"
            placeholder="Email, nombre o teléfono"
            maxLength={100}
            value={filters.q}
            onChange={(e) => {
              setFilters((f) => ({ ...f, q: e.target.value }));
              setOffset(0);
            }}
          />
        </div>
        <div>
          <label className="label" htmlFor="f-type">Tipo</label>
          <select id="f-type" className="input" value={filters.type} onChange={(e) => update('type', e.target.value as UserFilters['type'])}>
            <option value="">Todos</option>
            {Object.entries(USER_TYPE_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-status">Estado</label>
          <select id="f-status" className="input" value={filters.status} onChange={(e) => update('status', e.target.value as UserFilters['status'])}>
            <option value="">Todos (sin anonimizados)</option>
            <option value="active">Activos</option>
            <option value="blocked">Bloqueados</option>
            <option value="pending">Pendientes</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-role">Rol</label>
          <select id="f-role" className="input" value={filters.role} onChange={(e) => update('role', e.target.value)}>
            <option value="">Todos</option>
            {(roles.data ?? []).map((r) => (
              <option key={r.code} value={r.code}>{r.name}</option>
            ))}
          </select>
        </div>
      </div>

      <QueryState query={users} loading="Cargando usuarios…">
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title="No hay usuarios con esos filtros" />
          ) : (
            <>
              <div className={`card overflow-x-auto ${users.isPlaceholderData ? 'opacity-60' : ''}`}>
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Usuario</th>
                      <th>Tipo</th>
                      <th>Roles</th>
                      <th>Estado</th>
                      <th>2FA</th>
                      <th>Último ingreso</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <Link href={`/usuarios/${u.id}`} prefetch={false} className="font-medium hover:text-accent">
                            {fullName(u.firstName, u.lastName)}
                          </Link>
                          <div className="text-xs text-ink-soft">{u.email}</div>
                        </td>
                        <td>{USER_TYPE_LABEL[u.type]}</td>
                        <td>
                          <div className="flex flex-wrap gap-1">
                            {u.roles.length === 0 ? <span className="text-ink-soft">—</span> : u.roles.map((r) => <Badge key={r}>{roleName(r)}</Badge>)}
                          </div>
                        </td>
                        <td>
                          <StatusBadge status={u.status} map={USER_STATUS} />
                        </td>
                        <td>
                          {u.mfaEnabled ? (
                            <Badge tone="ok">Activa</Badge>
                          ) : requiresMfa(u.roles) ? (
                            <Badge tone="warn">Pendiente</Badge>
                          ) : (
                            <span className="text-xs text-ink-soft">No</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-ink-soft">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Nunca'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination total={page.total} limit={LIMIT} offset={offset} onChange={setOffset} />
            </>
          )
        }
      </QueryState>

      {canCreate && (
        <CreateStaffUserModal
          open={creating}
          roles={roles.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={(res) => {
            setCreating(false);
            setCreated(res);
          }}
        />
      )}
      <TemporaryPasswordModal
        password={created?.temporaryPassword ?? null}
        email={created?.user.email ?? ''}
        mfaRequired={created ? requiresMfa(created.user.roles) : false}
        onClose={() => setCreated(null)}
      />
    </div>
  );
}
