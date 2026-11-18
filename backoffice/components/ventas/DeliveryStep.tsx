'use client';

import {
  COURIER_REASON_LABEL,
  FULFILLMENT_OPTIONS,
  fulfillmentBody,
  optionKey,
  selectedSavedAddress,
  type AddressForm,
  type AssistedDraft,
  type AssistedQuote,
} from '@/lib/assisted';
import { formatDate, formatMoney, formatTime } from '@/lib/format';
import type { Warehouse } from '@/lib/inventory';
import { Field } from './CustomerStep';
import { PinMap } from './PinMap';
import type { DraftPatch } from './useAssistedDraft';

const ADDRESS_FIELDS: { k: keyof AddressForm; label: string; max: number; required?: boolean; wide?: boolean }[] = [
  { k: 'mainStreet', label: 'Calle principal', max: 200, required: true, wide: true },
  { k: 'number', label: 'Número', max: 20 },
  { k: 'secondaryStreet', label: 'Calle secundaria', max: 200 },
  { k: 'neighborhood', label: 'Barrio o sector', max: 120 },
  { k: 'city', label: 'Ciudad', max: 80, required: true },
  { k: 'province', label: 'Provincia', max: 80 },
  { k: 'reference', label: 'Referencia', max: 300, wide: true },
];

/** Paso 3: tipo de entrega, dirección con pin en el mapa (o tienda de retiro) y opción/franja con su precio. */
export function DeliveryStep({
  draft,
  update,
  quote,
  quoteLoading,
  quoteError,
  pickups,
  selection,
}: {
  draft: AssistedDraft;
  update: (p: DraftPatch) => void;
  quote: AssistedQuote | undefined;
  quoteLoading: boolean;
  quoteError: React.ReactNode;
  pickups: Warehouse[];
  selection: Pick<AssistedDraft, 'optionKey' | 'slotId'>;
}) {
  const saved = selectedSavedAddress(draft);
  const addresses = draft.customerMode === 'registered' ? (draft.customer?.addresses ?? []) : [];
  const f = fulfillmentBody(draft);
  const needsPinForSaved = saved && (saved.lat === null || saved.lng === null);
  const delivery = draft.fulfillmentType !== 'pickup' && 'value' in f ? quote?.delivery : null;

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="label">Tipo de entrega</legend>
        <div className="flex flex-wrap gap-2">
          {FULFILLMENT_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={draft.fulfillmentType === o.value}
              className={draft.fulfillmentType === o.value ? 'btn-primary' : 'btn-ghost'}
              onClick={() => update({ fulfillmentType: o.value, optionKey: null, slotId: null })}
            >
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>

      {draft.fulfillmentType === 'pickup' ? (
        <div>
          <label htmlFor="d-pickup" className="label">
            Tienda de retiro
          </label>
          {pickups.length === 0 ? (
            <p className="text-sm text-warn">No hay tiendas habilitadas como punto de retiro.</p>
          ) : (
            <select id="d-pickup" className="input" required value={draft.pickupWarehouseId ?? ''} onChange={(e) => update({ pickupWarehouseId: e.target.value || null })}>
              <option value="">Elige una tienda</option>
              {pickups.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {w.city}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {addresses.length > 0 && (
            <fieldset className="space-y-1.5">
              <legend className="label">Dirección de entrega</legend>
              {addresses.map((a) => (
                <label key={a.addressId} className="flex cursor-pointer items-start gap-2 rounded-md border border-line p-2 text-sm has-[:checked]:border-ink">
                  <input
                    type="radio"
                    name="d-address"
                    className="mt-1"
                    checked={draft.addressMode === 'saved' && draft.addressId === a.addressId}
                    onChange={() => update({ addressMode: 'saved', addressId: a.addressId, pin: null })}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{a.label || 'Dirección'}</span>
                    {a.isDefault && <span className="ml-1 text-xs text-ink-soft">(predeterminada)</span>}
                    <span className="block text-ink-soft">
                      {[a.mainStreet, a.number, a.secondaryStreet].filter(Boolean).join(' ')} · {a.neighborhood ? `${a.neighborhood}, ` : ''}
                      {a.city}
                    </span>
                    {(a.lat === null || a.lng === null) && <span className="block text-xs text-warn">Sin ubicación en el mapa: hay que fijar el pin.</span>}
                  </span>
                </label>
              ))}
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-line p-2 text-sm has-[:checked]:border-ink">
                <input type="radio" name="d-address" checked={draft.addressMode === 'new'} onChange={() => update({ addressMode: 'new', addressId: null, pin: null })} />
                Otra dirección
              </label>
            </fieldset>
          )}

          {(draft.addressMode === 'new' || !saved) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {ADDRESS_FIELDS.map((fd) => (
                <div key={fd.k} className={fd.wide ? 'sm:col-span-2' : ''}>
                  <Field id={`a-${fd.k}`} label={fd.label + (fd.required ? '' : ' (opcional)')}>
                    <input
                      id={`a-${fd.k}`}
                      className="input"
                      required={fd.required}
                      maxLength={fd.max}
                      value={draft.address[fd.k]}
                      onChange={(e) => update((d) => ({ address: { ...d.address, [fd.k]: e.target.value } }))}
                    />
                  </Field>
                </div>
              ))}
            </div>
          )}

          {(draft.addressMode === 'new' || !saved || needsPinForSaved) && <PinMap value={draft.pin} onChange={(pin) => update({ pin })} />}

          {'missing' in f && <p className="text-sm text-warn">{f.missing}</p>}
        </div>
      )}

      {quoteError}

      {delivery && (
        <section aria-label="Opciones de envío" className="space-y-2">
          <h3 className="text-sm font-semibold">
            Opciones de envío {delivery.zone && <span className="font-normal text-ink-soft">· Zona {delivery.zone.name}</span>}
          </h3>
          {delivery.fulfillmentType !== draft.fulfillmentType && (
            <p className="rounded-md border border-info/30 bg-info/5 px-3 py-2 text-sm text-info">
              Para esta dirección se ofrece {delivery.fulfillmentType === 'courier' ? 'courier' : 'motorizado'}
              {delivery.reason ? `: ${COURIER_REASON_LABEL[delivery.reason] ?? delivery.reason}` : '.'}
            </p>
          )}
          {delivery.options.length === 0 && <p className="text-sm text-warn">No hay opciones de envío para esta dirección.</p>}
          {delivery.options.map((o) => {
            const key = optionKey(o);
            const checked = selection.optionKey === key;
            return (
              <div key={key} className={`rounded-md border p-3 ${checked ? 'border-ink' : 'border-line'}`}>
                <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2">
                    <input type="radio" name="d-option" checked={checked} onChange={() => update({ optionKey: key, slotId: o.slots?.[0]?.slotId ?? null })} />
                    <span>
                      <span className="font-medium">{o.label}</span>
                      {o.etaHours ? <span className="text-ink-soft"> · ~{o.etaHours} h</span> : null}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block">Envío {formatMoney(o.shippingTotal)}</span>
                    {!o.slots?.length && <span className="block text-xs text-ink-soft">Total {formatMoney(o.total)}</span>}
                  </span>
                </label>
                {checked && o.slots && o.slots.length > 0 && (
                  <fieldset className="mt-2 grid gap-1.5 sm:grid-cols-2">
                    <legend className="sr-only">Franja de entrega</legend>
                    {o.slots.map((s) => (
                      <label key={s.slotId} className="flex cursor-pointer items-center justify-between gap-2 rounded border border-line px-2 py-1.5 text-xs has-[:checked]:border-ink">
                        <span className="flex items-center gap-2">
                          <input type="radio" name="d-slot" checked={selection.slotId === s.slotId} onChange={() => update({ optionKey: key, slotId: s.slotId })} />
                          {formatDate(s.startsAt)} {formatTime(s.startsAt)}
                          {s.endsAt ? `–${formatTime(s.endsAt)}` : ''}
                        </span>
                        <span className="text-right">
                          {formatMoney(s.shippingTotal)} · <strong>{formatMoney(s.total)}</strong>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>
            );
          })}
        </section>
      )}
      {quoteLoading && draft.fulfillmentType !== 'pickup' && 'value' in f && <p className="text-xs text-ink-soft">Cotizando envío…</p>}
    </div>
  );
}
