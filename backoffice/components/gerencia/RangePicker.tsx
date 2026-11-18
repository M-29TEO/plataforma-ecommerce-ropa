'use client';

import { useId, useState } from 'react';
import { isoDateInStore } from '@/lib/format';
import { presetRange, RANGE_PRESETS, rangeError, type DateRange, type RangePreset } from '@/lib/reports';

export interface RangeValue {
  preset: RangePreset;
  range: DateRange;
}

export function initialRange(): RangeValue {
  return { preset: '30d', range: presetRange('30d') };
}

/**
 * Selector de rango (hoy, 7 días, 30 días, mes actual o personalizado). Las fechas son días
 * calendario de Ecuador; el personalizado se aplica con el botón para no consultar a cada tecla.
 */
export function RangePicker({ value, onChange }: { value: RangeValue; onChange: (v: RangeValue) => void }) {
  const id = useId();
  const [draft, setDraft] = useState<DateRange>(value.range);
  const [custom, setCustom] = useState(value.preset === 'custom');
  const error = custom ? rangeError(draft) : null;
  const today = isoDateInStore();

  function pick(preset: RangePreset) {
    if (preset === 'custom') {
      setCustom(true);
      setDraft(value.range);
      return;
    }
    setCustom(false);
    onChange({ preset, range: presetRange(preset) });
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div role="group" aria-label="Rango de fechas" className="inline-flex flex-wrap rounded-md border border-line bg-panel p-0.5">
        {RANGE_PRESETS.map((p) => {
          const active = custom ? p.id === 'custom' : p.id === value.preset;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={active}
              onClick={() => pick(p.id)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${active ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'}`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {custom && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!error) onChange({ preset: 'custom', range: draft });
          }}
        >
          <div>
            <label className="label" htmlFor={`${id}-from`}>
              Desde
            </label>
            <input id={`${id}-from`} type="date" className="input py-1" required max={today} value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor={`${id}-to`}>
              Hasta
            </label>
            <input id={`${id}-to`} type="date" className="input py-1" required max={today} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </div>
          <button type="submit" className="btn-primary btn-sm mb-0.5" disabled={Boolean(error)}>
            Aplicar
          </button>
          {error && (
            <p className="w-full text-xs text-danger" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
