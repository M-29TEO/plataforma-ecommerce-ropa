'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { ErrorState } from '@/components/ui/States';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/lib/api/client';
import { guestErrors, ID_TYPE_LABEL, type AssistedCustomer, type AssistedDraft, type GuestForm, type IdType } from '@/lib/assisted';
import { fullName } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import type { DraftPatch } from './useAssistedDraft';

/** Datos de factura a partir del cliente elegido (si tiene identificación válida para el SRI). */
function billingFrom(c: { firstName: string | null; lastName: string | null; email: string; idType?: string | null; idNumber?: string | null }, d: AssistedDraft) {
  const idType = c.idType === '04' || c.idType === '05' || c.idType === '06' ? (c.idType as IdType) : d.billing.idType;
  return {
    ...d.billing,
    name: fullName(c.firstName, c.lastName).replace('—', ''),
    email: c.email,
    idType,
    idNumber: c.idNumber ?? '',
  };
}

export function CustomerStep({ draft, update, showErrors }: { draft: AssistedDraft; update: (p: DraftPatch) => void; showErrors: boolean }) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 350);

  const customers = useQuery({
    queryKey: ['ventas', 'customers', q],
    queryFn: ({ signal }) => api<AssistedCustomer[]>('/assisted-orders/customers', { query: { q }, signal }),
    enabled: draft.customerMode === 'registered' && q.length >= 2 && q.length <= 100,
    staleTime: 30_000,
  });

  function choose(c: AssistedCustomer) {
    const def = c.addresses.find((a) => a.isDefault) ?? c.addresses[0];
    update((d) => ({
      customer: c,
      addressMode: def ? 'saved' : 'new',
      addressId: def?.addressId ?? null,
      pin: null,
      billing: billingFrom(c, d),
    }));
  }

  const setGuest = (k: keyof GuestForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    update((d) => {
      const guest = { ...d.guest, [k]: e.target.value };
      return { guest, billing: billingFrom({ ...guest, idType: guest.idType || null }, d) };
    });

  const errors = guestErrors(draft.guest);
  const err = (k: keyof GuestForm) => (showErrors || draft.guest[k] !== '' ? errors[k] : undefined);

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border border-line p-0.5" role="tablist" aria-label="Tipo de cliente">
        {(
          [
            ['registered', 'Cliente registrado'],
            ['guest', 'Cliente invitado'],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={draft.customerMode === mode}
            className={`rounded px-3 py-1.5 text-sm ${draft.customerMode === mode ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'}`}
            onClick={() => update({ customerMode: mode, addressMode: mode === 'guest' ? 'new' : draft.addressMode })}
          >
            {label}
          </button>
        ))}
      </div>

      {draft.customerMode === 'registered' ? (
        <div className="space-y-3">
          {draft.customer && (
            <div className="card flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="font-medium">
                  {fullName(draft.customer.firstName, draft.customer.lastName)}{' '}
                  {draft.customer.status === 'blocked' && <Badge tone="danger">Bloqueado</Badge>}
                </p>
                <p className="truncate text-sm text-ink-soft">
                  {draft.customer.email}
                  {draft.customer.phone ? ` · ${draft.customer.phone}` : ''}
                  {draft.customer.idNumber ? ` · ${draft.customer.idNumber}` : ''}
                </p>
              </div>
              <button type="button" className="btn-ghost btn-sm" onClick={() => update({ customer: null, addressId: null, addressMode: 'new' })}>
                Cambiar
              </button>
            </div>
          )}
          {draft.customer?.status === 'blocked' && (
            <p className="text-sm text-danger" role="alert">
              La cuenta del cliente está bloqueada: no puede comprar. Usa otro cliente.
            </p>
          )}
          {!draft.customer && (
            <>
              <div>
                <label htmlFor="c-search" className="label">
                  Buscar cliente
                </label>
                <input
                  id="c-search"
                  className="input"
                  type="search"
                  placeholder="Email, nombre, teléfono o cédula"
                  maxLength={100}
                  value={search}
                  autoFocus
                  onChange={(e) => setSearch(e.target.value)}
                />
                <p className="mt-1 text-xs text-ink-soft">Escribe al menos 2 caracteres.</p>
              </div>
              {customers.isFetching && <Spinner label="Buscando…" />}
              {customers.error && <ErrorState error={customers.error} onRetry={() => void customers.refetch()} />}
              {customers.data && customers.data.length === 0 && !customers.isFetching && (
                <p className="text-sm text-ink-soft">
                  Sin resultados.{' '}
                  <button type="button" className="underline" onClick={() => update({ customerMode: 'guest' })}>
                    Registrar como invitado
                  </button>
                </p>
              )}
              {customers.data && customers.data.length > 0 && (
                <ul className="card divide-y divide-line">
                  {customers.data.map((c) => (
                    <li key={c.userId}>
                      <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-sand/50" onClick={() => choose(c)}>
                        <span className="min-w-0">
                          <span className="block font-medium">{fullName(c.firstName, c.lastName)}</span>
                          <span className="block truncate text-xs text-ink-soft">
                            {c.email}
                            {c.phone ? ` · ${c.phone}` : ''}
                            {c.idNumber ? ` · ${c.idNumber}` : ''}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2 text-xs text-ink-soft">
                          {c.status === 'blocked' && <Badge tone="danger">Bloqueado</Badge>}
                          {c.addresses.length} dirección(es)
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="g-first" label="Nombre" error={err('firstName')}>
            <input id="g-first" className="input" required maxLength={80} value={draft.guest.firstName} onChange={setGuest('firstName')} autoComplete="off" />
          </Field>
          <Field id="g-last" label="Apellido" error={err('lastName')}>
            <input id="g-last" className="input" required maxLength={80} value={draft.guest.lastName} onChange={setGuest('lastName')} autoComplete="off" />
          </Field>
          <Field id="g-email" label="Email" error={err('email')}>
            <input id="g-email" className="input" type="email" required maxLength={254} value={draft.guest.email} onChange={setGuest('email')} autoComplete="off" />
          </Field>
          <Field id="g-phone" label="Teléfono (WhatsApp)" error={err('phone')}>
            <input id="g-phone" className="input" type="tel" required inputMode="tel" placeholder="0991234567" maxLength={20} value={draft.guest.phone} onChange={setGuest('phone')} />
          </Field>
          <Field id="g-idtype" label="Identificación (opcional)">
            <select id="g-idtype" className="input" value={draft.guest.idType} onChange={setGuest('idType')}>
              <option value="">Sin identificación</option>
              {(Object.keys(ID_TYPE_LABEL) as IdType[]).map((t) => (
                <option key={t} value={t}>
                  {ID_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>
          {draft.guest.idType && (
            <Field id="g-idnum" label={`Número de ${ID_TYPE_LABEL[draft.guest.idType]}`} error={err('idNumber')}>
              <input id="g-idnum" className="input font-mono" required maxLength={20} value={draft.guest.idNumber} onChange={setGuest('idNumber')} />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

export function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children}
      {error && (
        <p className="mt-1 text-xs text-danger" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
