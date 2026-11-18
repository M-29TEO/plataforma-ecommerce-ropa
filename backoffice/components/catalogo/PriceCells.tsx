'use client';

import { useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { errorMessage } from '@/lib/api/client';
import { type AdminVariant, normalizeMoney, parseMoney, type PricePair } from '@/lib/catalog';
import { useProduct } from './hooks';
import { Swatch } from './Swatch';

/**
 * Celda de monto editable en línea: el texto se confirma al salir del campo o con Enter. Vacío =
 * null (si `allowEmpty`); un texto inválido se marca y no se confirma. Se remonta con `key` cuando
 * el valor cambia desde fuera (herramienta "aplicar a seleccionados").
 */
export function MoneyCell({
  value,
  onCommit,
  label,
  placeholder,
  allowEmpty = true,
  changed = false,
}: {
  value: string | null;
  onCommit: (v: string | null) => void;
  label: string;
  placeholder?: string;
  allowEmpty?: boolean;
  changed?: boolean;
}) {
  const [text, setText] = useState(value ?? '');
  const trimmed = text.trim();
  const invalid = trimmed ? parseMoney(trimmed) === null : !allowEmpty;

  const commit = () => {
    if (invalid) return;
    const next = trimmed ? parseMoney(trimmed) : null;
    if (next !== value) onCommit(next);
    setText(next ?? '');
  };

  return (
    <input
      aria-label={label}
      aria-invalid={invalid || undefined}
      className={`input num w-24 py-1 ${invalid ? 'border-danger' : changed ? 'border-warn bg-warn/5' : ''}`}
      inputMode="decimal"
      placeholder={placeholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') setText(value ?? '');
      }}
    />
  );
}

export interface VariantRowInfo {
  id: string;
  productId: string;
  label: string;
  productBasePrice: string;
  original: PricePair;
}

export function variantLabel(productName: string, v: AdminVariant): string {
  return [productName, v.color?.name, v.size?.code].filter(Boolean).join(' · ') + ` (${v.sku})`;
}

/**
 * Variantes de un producto desplegado en la tabla de precios. Lee el detalle del producto (misma
 * caché que la ficha) y delega en el padre el estado de cambios y selección.
 */
export function VariantPriceRows({
  productId,
  productName,
  inheritedPrice,
  colSpan,
  current,
  isSelected,
  onToggle,
  onToggleAll,
  onChange,
  errorOf,
}: {
  productId: string;
  productName: string;
  /** Precio base del producto con los cambios pendientes (lo que heredan). */
  inheritedPrice: string | null;
  colSpan: number;
  current: (info: VariantRowInfo) => PricePair;
  isSelected: (id: string) => boolean;
  onToggle: (info: VariantRowInfo, on: boolean) => void;
  onToggleAll: (infos: VariantRowInfo[], on: boolean) => void;
  onChange: (info: VariantRowInfo, after: PricePair) => void;
  errorOf: (id: string) => string | null;
}) {
  const detail = useProduct(productId);

  if (detail.isPending)
    return (
      <tr>
        <td colSpan={colSpan} className="bg-sand/30 pl-10"><Spinner label="Cargando variantes…" /></td>
      </tr>
    );
  if (detail.error || !detail.data)
    return (
      <tr>
        <td colSpan={colSpan} className="bg-danger/5 pl-10 text-sm text-danger">
          {errorMessage(detail.error) || 'No se pudieron cargar las variantes.'}{' '}
          <button className="underline" onClick={() => void detail.refetch()}>Reintentar</button>
        </td>
      </tr>
    );

  const p = detail.data;
  const base = normalizeMoney(p.basePrice) ?? '0.00';
  const infos: VariantRowInfo[] = p.variants.map((v) => ({
    id: v.id,
    productId,
    label: variantLabel(productName, v),
    productBasePrice: base,
    original: { price: normalizeMoney(v.price), compareAtPrice: normalizeMoney(v.compareAtPrice) },
  }));

  if (infos.length === 0)
    return (
      <tr>
        <td colSpan={colSpan} className="bg-sand/30 pl-10 text-xs text-ink-soft">Sin variantes.</td>
      </tr>
    );

  const allOn = infos.every((i) => isSelected(i.id));

  return (
    <>
      <tr className="bg-sand/30">
        <td />
        <td colSpan={colSpan - 1} className="py-1 text-xs">
          <label className="inline-flex items-center gap-1.5 text-ink-soft">
            <input type="checkbox" checked={allOn} onChange={(e) => onToggleAll(infos, e.target.checked)} />
            Seleccionar las {infos.length} variantes
          </label>
        </td>
      </tr>
      {infos.map((info, i) => {
        const v = p.variants[i];
        const cur = current(info);
        const err = errorOf(info.id);
        return (
          <tr key={info.id} className="bg-sand/30">
            <td>
              <input type="checkbox" aria-label={`Seleccionar ${info.label}`} checked={isSelected(info.id)} onChange={(e) => onToggle(info, e.target.checked)} />
            </td>
            <td className="pl-8">
              <span className="inline-flex items-center gap-1.5 text-xs">
                <Swatch hex={v.color?.hex} />
                {[v.color?.name, v.size?.code].filter(Boolean).join(' · ') || 'Única'}
                <span className="font-mono text-ink-soft">{v.sku}</span>
                {v.status === 'inactive' && <span className="text-ink-soft">(inactiva)</span>}
              </span>
              {err && <p className="text-xs text-danger">{err}</p>}
            </td>
            <td className="num">
              <MoneyCell
                key={`p:${cur.price}`}
                label={`Precio de ${info.label}`}
                value={cur.price}
                placeholder={`hereda ${inheritedPrice ?? base}`}
                changed={cur.price !== info.original.price}
                onCommit={(price) => onChange(info, { ...cur, price })}
              />
            </td>
            <td className="num">
              <MoneyCell
                key={`c:${cur.compareAtPrice}`}
                label={`Tachado de ${info.label}`}
                value={cur.compareAtPrice}
                placeholder="—"
                changed={cur.compareAtPrice !== info.original.compareAtPrice}
                onCommit={(compareAtPrice) => onChange(info, { ...cur, compareAtPrice })}
              />
            </td>
            <td />
          </tr>
        );
      })}
    </>
  );
}
