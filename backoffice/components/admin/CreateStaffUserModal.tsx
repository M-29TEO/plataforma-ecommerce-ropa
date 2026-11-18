'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { api, errorMessage, isApiError } from '@/lib/api/client';
import { assignableRoles, type CreatedStaffUser, type Role, validateNewStaff } from '@/lib/admin';

const EMPTY = { email: '', firstName: '', lastName: '', phone: '' };

/** Alta de personal: el servidor genera la contraseña temporal y la devuelve una sola vez. */
export function CreateStaffUserModal({
  open,
  roles,
  onClose,
  onCreated,
}: {
  open: boolean;
  roles: Role[];
  onClose: () => void;
  onCreated: (result: CreatedStaffUser) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const staffRoles = assignableRoles(roles, 'staff');

  const create = useMutation({
    mutationFn: (body: object) => api<CreatedStaffUser>('/iam/users', { method: 'POST', body }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['iam', 'users'] });
      setForm(EMPTY);
      setSelected([]);
      onCreated(res);
    },
    onError: (e) => {
      if (isApiError(e, 'EMAIL_TAKEN')) setError('Ya existe una cuenta con ese email.');
      else if (isApiError(e, 'ROLE_NOT_ALLOWED_FOR_USER_TYPE')) setError('Alguno de los roles no es para personal.');
      else setError(errorMessage(e));
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const input = {
      email: form.email.trim(),
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      phone: form.phone.trim() || undefined,
      roles: selected,
    };
    const problem = validateNewStaff(input);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    create.mutate(input);
  }

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Modal open={open} onClose={onClose} title="Nuevo usuario del personal" size="md">
      <form onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <label className="label" htmlFor="nu-email">Email</label>
          <input id="nu-email" type="email" className="input" required autoComplete="off" value={form.email} onChange={set('email')} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="nu-first">Nombre</label>
            <input id="nu-first" className="input" required maxLength={100} value={form.firstName} onChange={set('firstName')} />
          </div>
          <div>
            <label className="label" htmlFor="nu-last">Apellido</label>
            <input id="nu-last" className="input" required maxLength={100} value={form.lastName} onChange={set('lastName')} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="nu-phone">Teléfono (opcional)</label>
          <input id="nu-phone" type="tel" className="input" placeholder="+593991234567" value={form.phone} onChange={set('phone')} />
        </div>
        <fieldset>
          <legend className="label">Roles</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {staffRoles.map((r) => (
              <label key={r.code} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(r.code)}
                  onChange={(e) => setSelected((s) => (e.target.checked ? [...s, r.code] : s.filter((c) => c !== r.code)))}
                />
                {r.name}
              </label>
            ))}
          </div>
          {selected.includes('admin') && (
            <p className="mt-2 text-xs text-warn">Un administrador deberá configurar 2FA en su primer ingreso.</p>
          )}
        </fieldset>
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={create.isPending}>
            Cancelar
          </button>
          <button className="btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Creando…' : 'Crear usuario'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
