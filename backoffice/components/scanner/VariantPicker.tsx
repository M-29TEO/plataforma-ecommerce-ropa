'use client';

import { useState } from 'react';
import { errorMessage } from '@/lib/api/client';
import { formatMoney } from '@/lib/format';
import { variantLabel, type VariantLookupItem } from '@/lib/scanner';
import { BarcodeScanner } from './BarcodeScanner';
import { resolveCode } from './variant-cache';

/**
 * Elegir una variante escaneando su código (cámara o lector) o escribiendo SKU / nombre.
 * Un código de barras exacto o un SKU exacto se elige directo; si no, muestra las coincidencias.
 */
export function VariantPicker({
  onSelect,
  label = 'Código, SKU o nombre',
  active = true,
}: {
  onSelect: (v: VariantLookupItem) => void;
  label?: string;
  active?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<VariantLookupItem[] | null>(null);
  const [message, setMessage] = useState('');

  async function handle(code: string) {
    setBusy(true);
    setMessage('');
    try {
      const { match, options } = await resolveCode(code);
      if (match) {
        setOptions(null);
        onSelect(match);
      } else if (options.length === 0) {
        setOptions(null);
        setMessage(`No se encontró ninguna variante para "${code}".`);
        try {
          navigator.vibrate?.([80, 60, 80]);
        } catch {
          // Sin vibración.
        }
      } else {
        setOptions(options);
      }
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <BarcodeScanner onDetected={(c) => void handle(c)} active={active} busy={busy} label={label} placeholder="Escanea o escribe y pulsa Enter" />
      {message && (
        <p className="text-sm text-danger" role="alert">
          {message}
        </p>
      )}
      {options && (
        <div className="card divide-y divide-line">
          <p className="px-3 py-2 text-xs text-ink-soft">{options.length} coincidencia(s): elige una</p>
          {options.map((v) => (
            <button
              key={v.variantId}
              type="button"
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-sand/50"
              onClick={() => {
                setOptions(null);
                onSelect(v);
              }}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{variantLabel(v)}</span>
                <span className="block font-mono text-xs text-ink-soft">
                  {v.sku}
                  {v.barcode ? ` · ${v.barcode}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-xs text-ink-soft">{formatMoney(v.price)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
