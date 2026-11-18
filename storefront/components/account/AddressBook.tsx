'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api/client';
import { type AddressForm, addressReady, emptyAddress } from '@/lib/checkout';
import type { Address } from '@/lib/commerce-types';
import { AddressFields } from '../checkout/AddressFields';
import { LocationPicker } from '../map/LocationPicker';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';

/** Libreta de direcciones: alta con pin en el mapa, corregir la ubicación, predeterminada y borrar. */
export function AddressBook() {
  const { user } = useAuth();
  const toast = useToast();
  const [list, setList] = useState<Address[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<AddressForm>(emptyAddress);
  const [label, setLabel] = useState('');
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<Address[]>('/me/addresses').then(setList), []);
  useEffect(() => {
    void load().catch((e) => toast(errorMessage(e), 'error'));
  }, [load, toast]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      await load();
      toast(ok, 'ok');
      return true;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        api('/me/addresses', {
          method: 'POST',
          body: {
            ...(label.trim() ? { label: label.trim() } : {}),
            recipientName: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'Cliente',
            recipientPhone: user?.phone ?? '0999999999',
            province: form.province,
            city: form.city.trim(),
            mainStreet: form.mainStreet.trim(),
            ...(form.secondaryStreet.trim() ? { crossStreet: form.secondaryStreet.trim() } : {}),
            ...(form.number.trim() ? { houseNumber: form.number.trim() } : {}),
            ...(form.neighborhood.trim() ? { neighborhood: form.neighborhood.trim() } : {}),
            ...(form.reference.trim() ? { reference: form.reference.trim() } : {}),
            pin: { lat: form.lat, lng: form.lng },
          },
        }),
      'Dirección guardada',
    );
    if (ok) {
      setAdding(false);
      setForm(emptyAddress());
      setLabel('');
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Direcciones</h1>
        {!adding && (list?.length ?? 0) < 10 && (
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            Agregar dirección
          </button>
        )}
      </div>

      {adding && (
        <form onSubmit={create} className="card mt-6 space-y-4 p-5">
          <div>
            <label className="label" htmlFor="addr-label">
              Nombre (opcional)
            </label>
            <input id="addr-label" className="input" placeholder="Casa, oficina…" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <AddressFields value={form} onChange={setForm} geocode />
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy || !addressReady(form)}>
              Guardar
            </button>
            <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      <ul className="mt-6 space-y-3">
        {list?.map((a) => (
          <li key={a.id} className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="text-sm">
                <p className="font-medium">
                  {a.label ?? 'Dirección'} {a.isDefault && <span className="chip ml-2">Predeterminada</span>}
                </p>
                <p className="text-ink-soft">
                  {[a.mainStreet, a.crossStreet].filter(Boolean).join(' y ')} {a.houseNumber}
                  {a.neighborhood && ` · ${a.neighborhood}`} · {a.city}, {a.province}
                </p>
                {a.reference && <p className="text-xs text-ink-soft">{a.reference}</p>}
                {a.needsPin && <p className="mt-1 text-xs text-danger">Sin ubicación en el mapa: márcala para poder usarla en el checkout.</p>}
                {!a.needsPin && a.pinRecommended && <p className="mt-1 text-xs text-warn">La ubicación es aproximada: ajústala a tu puerta.</p>}
              </div>
              <div className="flex flex-wrap gap-2 text-sm">
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    setPinFor(pinFor === a.id ? null : a.id);
                    setPin(a.location);
                  }}
                >
                  {a.location ? 'Ajustar ubicación' : 'Marcar en el mapa'}
                </button>
                {!a.isDefault && (
                  <button type="button" className="underline" disabled={busy} onClick={() => void run(() => api(`/me/addresses/${a.id}/default`, { method: 'POST' }), 'Dirección predeterminada actualizada')}>
                    Predeterminar
                  </button>
                )}
                <button
                  type="button"
                  className="text-danger underline"
                  disabled={busy}
                  onClick={() => window.confirm('¿Eliminar esta dirección?') && void run(() => api(`/me/addresses/${a.id}`, { method: 'DELETE' }), 'Dirección eliminada')}
                >
                  Eliminar
                </button>
              </div>
            </div>
            {pinFor === a.id && (
              <div className="mt-4 space-y-3">
                <LocationPicker value={pin} onChange={setPin} height={260} />
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || !pin}
                  onClick={async () => {
                    if (pin && (await run(() => api(`/me/addresses/${a.id}/location`, { method: 'PUT', body: pin }), 'Ubicación guardada'))) setPinFor(null);
                  }}
                >
                  Guardar ubicación
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {list && list.length === 0 && !adding && <p className="mt-6 text-ink-soft">No tienes direcciones guardadas. Se guardan también al comprar.</p>}
    </div>
  );
}
