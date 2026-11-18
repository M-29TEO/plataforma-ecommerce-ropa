'use client';

import { useState } from 'react';
import {
  DELIVERY_MODE_LABEL,
  DELIVERY_MODES,
  type DeliveryMode,
  normalizeMoney,
  validateZoneFields,
  type WarehouseOption,
  type Zone,
  type ZoneFields,
} from '@/lib/admin';

interface FormState {
  name: string;
  city: string;
  deliveryMode: DeliveryMode;
  priority: string;
  baseFee: string;
  feePerKm: string;
  feePerExtraKg: string;
  maxWeightKg: string;
  freeShippingThreshold: string;
  sameDayCutoff: string;
  servingWarehouseId: string;
}

function initialState(zone?: Zone | null): FormState {
  return {
    name: zone?.name ?? '',
    city: zone?.city ?? 'Quito',
    deliveryMode: zone?.deliveryMode ?? 'rider',
    priority: String(zone?.priority ?? 100),
    baseFee: zone?.baseFee ?? '2.50',
    feePerKm: zone?.feePerKm ?? '0.00',
    feePerExtraKg: zone?.feePerExtraKg ?? '0.00',
    maxWeightKg: String(zone?.maxWeightKg ?? 15),
    freeShippingThreshold: zone?.freeShippingThreshold ?? '',
    sameDayCutoff: zone?.sameDayCutoff ?? '',
    servingWarehouseId: zone?.servingWarehouseId ?? '',
  };
}

function toFields(s: FormState): ZoneFields {
  return {
    name: s.name.trim(),
    city: s.city.trim(),
    deliveryMode: s.deliveryMode,
    priority: Number(s.priority),
    baseFee: normalizeMoney(s.baseFee),
    feePerKm: normalizeMoney(s.feePerKm),
    feePerExtraKg: normalizeMoney(s.feePerExtraKg),
    maxWeightKg: Number(s.maxWeightKg.replace(',', '.')),
    freeShippingThreshold: s.freeShippingThreshold.trim() ? normalizeMoney(s.freeShippingThreshold) : null,
    sameDayCutoff: s.sameDayCutoff.trim() || null,
    servingWarehouseId: s.servingWarehouseId.trim() || null,
  };
}

/**
 * Datos y tarifas de la zona. `warehouses` null = el rol no puede listar bodegas (inventory.read):
 * se pide el id a mano.
 */
export function ZoneForm({
  zone,
  warehouses,
  busy,
  submitLabel,
  extraError,
  onSubmit,
  onCancel,
}: {
  zone?: Zone | null;
  warehouses: WarehouseOption[] | null;
  busy: boolean;
  submitLabel: string;
  /** Error ajeno a los campos (p. ej. el área), se valida antes de enviar. */
  extraError?: () => string | null;
  onSubmit: (fields: ZoneFields) => void;
  onCancel: () => void;
}) {
  const [s, setS] = useState<FormState>(() => initialState(zone));
  const [error, setError] = useState('');
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setS((p) => ({ ...p, [k]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const fields = toFields(s);
    const problem = extraError?.() ?? validateZoneFields(fields);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    onSubmit(fields);
  }

  const needsWarehouse = s.deliveryMode !== 'courier';
  const shipping = warehouses?.filter((w) => w.active && w.shipsOnline) ?? null;

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div>
        <label className="label" htmlFor="z-name">Nombre</label>
        <input id="z-name" className="input" required minLength={2} maxLength={120} value={s.name} onChange={set('name')} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="z-city">Ciudad</label>
          <input id="z-city" className="input" required minLength={2} maxLength={80} value={s.city} onChange={set('city')} />
        </div>
        <div>
          <label className="label" htmlFor="z-priority">Prioridad</label>
          <input id="z-priority" type="number" inputMode="numeric" min={0} max={10000} step={1} className="input" value={s.priority} onChange={set('priority')} />
        </div>
      </div>
      <p className="-mt-1 text-xs text-ink-soft">Si un punto cae en dos zonas, gana la de menor prioridad.</p>
      <div>
        <label className="label" htmlFor="z-mode">Modo de entrega</label>
        <select id="z-mode" className="input" value={s.deliveryMode} onChange={set('deliveryMode')}>
          {DELIVERY_MODES.map((m) => (
            <option key={m} value={m}>{DELIVERY_MODE_LABEL[m]}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="z-wh">Bodega que la atiende{needsWarehouse ? '' : ' (opcional)'}</label>
        {shipping ? (
          <select id="z-wh" className="input" required={needsWarehouse} value={s.servingWarehouseId} onChange={set('servingWarehouseId')}>
            <option value="">— Ninguna —</option>
            {shipping.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.code}) · {w.city}
              </option>
            ))}
            {s.servingWarehouseId && !shipping.some((w) => w.id === s.servingWarehouseId) && (
              <option value={s.servingWarehouseId}>Bodega no disponible ({s.servingWarehouseId.slice(0, 8)}…)</option>
            )}
          </select>
        ) : (
          <input id="z-wh" className="input font-mono" placeholder="Id (UUID) de la bodega" value={s.servingWarehouseId} onChange={set('servingWarehouseId')} />
        )}
        {needsWarehouse && <p className="mt-1 text-xs text-ink-soft">Origen de la distancia que cobra el motorizado.</p>}
      </div>

      <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <legend className="label col-span-full">Tarifas (USD, IVA incluido)</legend>
        <MoneyInput id="z-base" label="Base" value={s.baseFee} onChange={set('baseFee')} required />
        <MoneyInput id="z-km" label="Por km" value={s.feePerKm} onChange={set('feePerKm')} />
        <MoneyInput id="z-kg" label="Por kg extra" value={s.feePerExtraKg} onChange={set('feePerExtraKg')} />
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="z-weight">Peso máximo (kg)</label>
          <input id="z-weight" type="number" inputMode="decimal" min={0.1} max={1000} step="0.1" className="input" value={s.maxWeightKg} onChange={set('maxWeightKg')} />
        </div>
        <MoneyInput id="z-free" label="Envío gratis desde" value={s.freeShippingThreshold} onChange={set('freeShippingThreshold')} placeholder="Sin envío gratis" />
      </div>
      <div>
        <label className="label" htmlFor="z-cutoff">Corte para entrega el mismo día (hora de Ecuador)</label>
        <input id="z-cutoff" type="time" className="input" value={s.sameDayCutoff} onChange={set('sameDayCutoff')} />
      </div>

      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button className="btn-primary" disabled={busy}>
          {busy ? 'Guardando…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function MoneyInput({
  id,
  label,
  value,
  onChange,
  required,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} className="input num" inputMode="decimal" required={required} placeholder={placeholder} value={value} onChange={onChange} />
    </div>
  );
}
