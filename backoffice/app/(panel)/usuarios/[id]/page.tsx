'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { TemporaryPasswordModal } from '@/components/admin/TemporaryPasswordModal';
import { useAuth, useCan } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/providers/ToastProvider';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryState } from '@/components/ui/States';
import {
  type AdminUserDetail,
  assignableRoles,
  blockAction,
  isTemporarilyLocked,
  requiresMfa,
  type Role,
  USER_STATUS,
  USER_TYPE_LABEL,
  type UserRole,
} from '@/lib/admin';
import { api } from '@/lib/api/client';
import { formatDateTime, fullName } from '@/lib/format';

type Pending =
  | { kind: 'block' | 'unblock' | 'password' | 'mfa' }
  | { kind: 'assign'; code: string; name: string }
  | { kind: 'remove'; code: string; name: string };

/** Ficha de un usuario: datos, roles y acciones de cuenta (bloqueo, contraseña temporal, 2FA). */
export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user: me } = useAuth();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [newRole, setNewRole] = useState('');
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const isSelf = me?.id === id;

  const detail = useQuery({
    queryKey: ['iam', 'users', 'detail', id],
    queryFn: ({ signal }) => api<AdminUserDetail>(`/iam/users/${id}`, { signal }),
  });
  const userRoles = useQuery({
    queryKey: ['iam', 'users', 'roles', id],
    queryFn: ({ signal }) => api<UserRole[]>(`/iam/users/${id}/roles`, { signal }),
    enabled: can('iam.roles.read'),
  });
  const roles = useQuery({
    queryKey: ['iam', 'roles'],
    queryFn: ({ signal }) => api<Role[]>('/iam/roles', { signal }),
    enabled: can('iam.roles.read'),
    staleTime: 5 * 60_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['iam', 'users'] });
  };

  const action = useMutation({
    mutationFn: async (p: Pending): Promise<string> => {
      switch (p.kind) {
        case 'block':
        case 'unblock':
          await api(`/iam/users/${id}/${p.kind}`, { method: 'POST' });
          return p.kind === 'block' ? 'Usuario bloqueado y sesiones cerradas' : 'Usuario desbloqueado';
        case 'password': {
          const r = await api<{ temporaryPassword: string }>(`/iam/users/${id}/password-reset`, { method: 'POST' });
          setTempPassword(r.temporaryPassword);
          return 'Contraseña temporal generada';
        }
        case 'mfa': {
          const r = await api<{ revokedSessions: number }>(`/iam/users/${id}/mfa/reset`, { method: 'POST' });
          return `2FA reseteado; se cerraron ${r.revokedSessions} sesión(es)`;
        }
        case 'assign':
          await api(`/iam/users/${id}/roles/${encodeURIComponent(p.code)}`, { method: 'PUT' });
          setNewRole('');
          return `Rol ${p.name} asignado`;
        case 'remove':
          await api(`/iam/users/${id}/roles/${encodeURIComponent(p.code)}`, { method: 'DELETE' });
          return `Rol ${p.name} retirado`;
      }
    },
    onSuccess: (msg) => {
      toast.ok(msg);
      setPending(null);
      refresh();
    },
    onError: (e) => {
      toast.error(e);
      setPending(null);
    },
  });

  return (
    <div className="max-w-4xl">
      <QueryState query={detail} loading="Cargando usuario…">
        {(u) => {
          const held = userRoles.data ?? u.roles.map((code) => ({ code, name: roles.data?.find((r) => r.code === code)?.name ?? code, grantedBy: null, grantedAt: '' }));
          const available = assignableRoles(roles.data ?? [], u.type).filter((r) => !held.some((h) => h.code === r.code));
          const block = blockAction(u.status);
          const locked = isTemporarilyLocked(u.lockedUntil);
          return (
            <>
              <PageHeader
                back={{ href: '/usuarios', label: 'Usuarios' }}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {fullName(u.firstName, u.lastName)} <StatusBadge status={u.status} map={USER_STATUS} />
                  </span>
                }
                description={u.email}
              />

              {isSelf && (
                <p className="mb-4 rounded-md border border-info/30 bg-info/5 px-3 py-2 text-sm text-info">
                  Es tu propia cuenta: no puedes bloquearla, resetearla ni cambiar sus roles. Usa «Mi cuenta» para tu 2FA y sesiones.
                </p>
              )}

              <section className="card p-5">
                <dl className="grid gap-3 text-sm sm:grid-cols-3">
                  <Field label="Tipo">{USER_TYPE_LABEL[u.type]}</Field>
                  <Field label="Teléfono">{u.phone ?? '—'}</Field>
                  <Field label="Cuenta creada">{formatDateTime(u.createdAt)}</Field>
                  <Field label="Último ingreso">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Nunca'}</Field>
                  <Field label="Verificación en dos pasos">
                    {u.mfaEnabled ? <Badge tone="ok">Activa</Badge> : requiresMfa(u.roles) ? <Badge tone="warn">Pendiente (obligatoria)</Badge> : <Badge>Inactiva</Badge>}
                  </Field>
                  <Field label="Bloqueo por intentos">
                    {locked ? <Badge tone="danger">Hasta {formatDateTime(u.lockedUntil)}</Badge> : 'No'}
                  </Field>
                </dl>
              </section>

              <section className="card mt-5 p-5">
                <h2 className="font-semibold">Acciones de cuenta</h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  {can('iam.users.write') && block && (
                    <button className={block === 'block' ? 'btn-danger' : 'btn-ghost'} disabled={isSelf} onClick={() => setPending({ kind: block })}>
                      {block === 'block' ? 'Bloquear' : 'Desbloquear'}
                    </button>
                  )}
                  {can('iam.users.write') && (
                    <button className="btn-ghost" disabled={isSelf} onClick={() => setPending({ kind: 'password' })}>
                      Generar contraseña temporal
                    </button>
                  )}
                  {can('iam.mfa.reset') && u.mfaEnabled && (
                    <button className="btn-ghost" disabled={isSelf} onClick={() => setPending({ kind: 'mfa' })}>
                      Resetear 2FA
                    </button>
                  )}
                  {!can('iam.users.write') && !can('iam.mfa.reset') && <p className="text-sm text-ink-soft">Tu rol solo permite consultar.</p>}
                </div>
              </section>

              <section className="card mt-5 p-5">
                <h2 className="font-semibold">Roles</h2>
                <p className="mt-1 text-xs text-ink-soft">
                  Los cambios de rol rigen en su siguiente ingreso o renovación de sesión (como máximo 15 minutos).
                </p>
                {held.length === 0 ? (
                  <p className="mt-3 text-sm text-ink-soft">Sin roles.</p>
                ) : (
                  <ul className="mt-3 divide-y divide-line">
                    {held.map((r) => (
                      <li key={r.code} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <div>
                          <span className="font-medium">{r.name}</span> <span className="font-mono text-xs text-ink-soft">{r.code}</span>
                          {r.grantedAt && <div className="text-xs text-ink-soft">Asignado el {formatDateTime(r.grantedAt)}</div>}
                        </div>
                        {can('iam.roles.assign') && (
                          <button className="btn-ghost btn-sm" disabled={isSelf} onClick={() => setPending({ kind: 'remove', code: r.code, name: r.name })}>
                            Quitar
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {can('iam.roles.assign') && available.length > 0 && (
                  <form
                    className="mt-4 flex flex-wrap items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const r = available.find((x) => x.code === newRole);
                      if (r) setPending({ kind: 'assign', code: r.code, name: r.name });
                    }}
                  >
                    <div className="min-w-48">
                      <label className="label" htmlFor="new-role">Asignar rol</label>
                      <select id="new-role" className="input" value={newRole} disabled={isSelf} onChange={(e) => setNewRole(e.target.value)}>
                        <option value="">Elige un rol…</option>
                        {available.map((r) => (
                          <option key={r.code} value={r.code}>{r.name}</option>
                        ))}
                      </select>
                    </div>
                    <button className="btn-primary" disabled={isSelf || !newRole}>
                      Asignar
                    </button>
                  </form>
                )}
              </section>

              <ConfirmDialog
                open={!!pending}
                title={pending ? confirmTitle(pending) : ''}
                confirmLabel={pending ? confirmLabel(pending) : ''}
                danger={pending?.kind !== 'unblock' && pending?.kind !== 'assign'}
                busy={action.isPending}
                onClose={() => setPending(null)}
                onConfirm={() => pending && action.mutate(pending)}
              >
                {pending && confirmBody(pending, u)}
              </ConfirmDialog>
              <TemporaryPasswordModal password={tempPassword} email={u.email} mfaRequired={requiresMfa(u.roles) && !u.mfaEnabled} onClose={() => setTempPassword(null)} />
            </>
          );
        }}
      </QueryState>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function confirmTitle(p: Pending): string {
  switch (p.kind) {
    case 'block':
      return 'Bloquear usuario';
    case 'unblock':
      return 'Desbloquear usuario';
    case 'password':
      return 'Generar contraseña temporal';
    case 'mfa':
      return 'Resetear 2FA';
    case 'assign':
      return `Asignar rol ${p.name}`;
    case 'remove':
      return `Quitar rol ${p.name}`;
  }
}

function confirmLabel(p: Pending): string {
  return { block: 'Bloquear', unblock: 'Desbloquear', password: 'Generar', mfa: 'Resetear 2FA', assign: 'Asignar', remove: 'Quitar' }[p.kind];
}

function confirmBody(p: Pending, u: AdminUserDetail): React.ReactNode {
  const who = fullName(u.firstName, u.lastName);
  switch (p.kind) {
    case 'block':
      return <p>{who} no podrá ingresar y se cerrarán todas sus sesiones abiertas.</p>;
    case 'unblock':
      return <p>{who} podrá volver a ingresar con su contraseña.</p>;
    case 'password':
      return (
        <p>
          Su contraseña actual dejará de funcionar y se cerrarán sus sesiones. La nueva contraseña temporal se mostrará una sola vez.
        </p>
      );
    case 'mfa':
      return <p>Se desactivará su verificación en dos pasos y se cerrarán sus sesiones. Si es administrador, deberá configurarla de nuevo al ingresar.</p>;
    case 'assign':
      return (
        <p>
          {who} obtendrá los permisos del rol {p.name} en su siguiente ingreso o renovación de sesión (≤ 15 min).
          {p.code === 'admin' && !u.mfaEnabled && ' Como administrador, deberá configurar 2FA.'}
        </p>
      );
    case 'remove':
      return <p>{who} perderá los permisos del rol {p.name} en su siguiente renovación de sesión (≤ 15 min).</p>;
  }
}
