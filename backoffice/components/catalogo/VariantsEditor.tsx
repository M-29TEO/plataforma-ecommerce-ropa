'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '@/components/providers/ToastProvider';
import { EmptyState } from '@/components/ui/States';
import { api, errorMessage } from '@/lib/api/client';
import {
  type AdminProductDetail,
  type AdminVariant,
  type Color,
  createVariantBody,
  emptyVariantForm,
  type Lookups,
  normalizeMoney,
  type Size,
  sortSizes,
  suggestSku,
  updateVariantBody,
  validateVariantForm,
  type VariantFormErrors,
  type VariantFormValues,
  variantToForm,
} from '@/lib/catalog';
import { CreateLookupModal, type LookupKind } from './CreateLookupModal';
import { productKey } from './hooks';
import { MatrixGenerator } from './MatrixGenerator';
import { ScanButton } from './ScanButton';
import { Swatch } from './Swatch';

/**
 * Variantes del producto: tabla editable fila por fila (cada fila guarda sola y muestra su error),
 * alta de una variante y generador de la matriz colores × tallas.
 */
export function VariantsEditor({
  product,
  lookups,
  flaggedIds = new Set<string>(),
}: {
  product: AdminProductDetail;
  lookups: Lookups;
  /** Variantes señaladas por un 422 INVALID_PRICE (details.variantIds) al guardar el producto. */
  flaggedIds?: ReadonlySet<string>;
}) {
  const [adding, setAdding] = useState(false);
  const [matrix, setMatrix] = useState(false);
  const [creating, setCreating] = useState<LookupKind | null>(null);
  const sizes = sortSizes(lookups.sizes);
  const basePrice = normalizeMoney(product.basePrice) ?? '0.00';

  return (
    <section className="card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Variantes ({product.variants.length})</h2>
          <p className="text-xs text-ink-soft">Precio vacío = hereda el precio base (${basePrice}).</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost btn-sm" onClick={() => setCreating('color')}>+ Color</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setCreating('size')}>+ Talla</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setMatrix(true)}>Generar colores × tallas</button>
          <button type="button" className="btn-primary btn-sm" onClick={() => setAdding(true)} disabled={adding}>Agregar variante</button>
        </div>
      </div>

      {product.variants.length === 0 && !adding ? (
        <EmptyState title="Este producto aún no tiene variantes">Agrega una o genera la matriz de colores y tallas.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="table-base min-w-[1100px]">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Código de barras</th>
                <th>Color</th>
                <th>Talla</th>
                <th className="num">Precio</th>
                <th className="num">Tachado</th>
                <th className="num">Peso (g)</th>
                <th>Estado</th>
                <th aria-label="Acciones" />
              </tr>
            </thead>
            <tbody>
              {product.variants.map((v) => (
                <VariantRow key={`${v.id}:${JSON.stringify(variantToForm(v))}`} productId={product.id} variant={v} basePrice={basePrice} colors={lookups.colors} sizes={sizes} flagged={flaggedIds.has(v.id)} />
              ))}
              {adding && <NewVariantRow product={product} basePrice={basePrice} colors={lookups.colors} sizes={sizes} onDone={() => setAdding(false)} />}
            </tbody>
          </table>
        </div>
      )}

      <MatrixGenerator open={matrix} onClose={() => setMatrix(false)} product={product} colors={lookups.colors} sizes={sizes} />
      <CreateLookupModal kind={creating} categories={lookups.categories} onClose={() => setCreating(null)} onCreated={() => setCreating(null)} />
    </section>
  );
}

/** Errores del API que se pueden pegar a un campo de la fila. */
function serverVariantErrors(error: unknown): VariantFormErrors {
  if (!error || typeof error !== 'object' || !('code' in error)) return {};
  const msg = errorMessage(error);
  switch ((error as { code: string }).code) {
    case 'SKU_TAKEN':
      return { sku: msg };
    case 'BARCODE_TAKEN':
      return { barcode: msg };
    case 'VARIANT_DUPLICATE':
      return { colorId: msg };
    case 'INVALID_PRICE':
      return { compareAtPrice: msg };
    default:
      return {};
  }
}

function VariantCells({
  values,
  onChange,
  errors,
  basePrice,
  colors,
  sizes,
  disabled,
}: {
  values: VariantFormValues;
  onChange: (v: VariantFormValues) => void;
  errors: VariantFormErrors;
  basePrice: string;
  colors: readonly Color[];
  sizes: readonly Size[];
  disabled: boolean;
}) {
  const set = <K extends keyof VariantFormValues>(k: K, val: VariantFormValues[K]) => onChange({ ...values, [k]: val });
  const cls = (k: keyof VariantFormValues, extra = '') => `input py-1.5 ${extra} ${errors[k] ? 'border-danger' : ''}`;
  const color = colors.find((c) => c.id === values.colorId);
  return (
    <>
      <td>
        <input aria-label="SKU" className={cls('sku', 'w-48 font-mono uppercase')} maxLength={64} value={values.sku} disabled={disabled} onChange={(e) => set('sku', e.target.value)} />
      </td>
      <td>
        <div className="flex items-center gap-1">
          <input
            aria-label="Código de barras"
            className={cls('barcode', 'w-36 font-mono')}
            maxLength={64}
            value={values.barcode}
            disabled={disabled}
            onChange={(e) => set('barcode', e.target.value)}
          />
          <ScanButton disabled={disabled} onCode={(code) => set('barcode', code)} />
        </div>
      </td>
      <td>
        <div className="flex items-center gap-1.5">
          <Swatch hex={color?.hex} />
          <select aria-label="Color" className={cls('colorId', 'w-32')} value={values.colorId} disabled={disabled} onChange={(e) => set('colorId', e.target.value)}>
            <option value="">Sin color</option>
            {colors.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </td>
      <td>
        <select aria-label="Talla" className={cls('sizeId', 'w-24')} value={values.sizeId} disabled={disabled} onChange={(e) => set('sizeId', e.target.value)}>
          <option value="">Única</option>
          {sizes.map((s) => (
            <option key={s.id} value={s.id}>{s.code}</option>
          ))}
        </select>
      </td>
      <td>
        <input
          aria-label="Precio propio (vacío = hereda)"
          className={cls('price', 'num w-24')}
          inputMode="decimal"
          placeholder={`hereda ${basePrice}`}
          value={values.price}
          disabled={disabled}
          onChange={(e) => set('price', e.target.value)}
        />
      </td>
      <td>
        <input aria-label="Precio tachado" className={cls('compareAtPrice', 'num w-24')} inputMode="decimal" placeholder="—" value={values.compareAtPrice} disabled={disabled} onChange={(e) => set('compareAtPrice', e.target.value)} />
      </td>
      <td>
        <input aria-label="Peso en gramos" className={cls('weightG', 'num w-20')} inputMode="numeric" value={values.weightG} disabled={disabled} onChange={(e) => set('weightG', e.target.value)} />
      </td>
      <td>
        <label className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
          <input type="checkbox" checked={values.status === 'active'} disabled={disabled} onChange={(e) => set('status', e.target.checked ? 'active' : 'inactive')} />
          {values.status === 'active' ? 'Activa' : 'Inactiva'}
        </label>
      </td>
    </>
  );
}

function ErrorRow({ errors, error }: { errors: VariantFormErrors; error?: unknown }) {
  const messages = [...new Set(Object.values(errors).filter(Boolean))];
  if (messages.length === 0 && !error) return null;
  return (
    <tr>
      <td colSpan={9} className="bg-danger/5 text-xs text-danger" role="alert">
        {messages.length > 0 ? messages.join(' · ') : errorMessage(error)}
      </td>
    </tr>
  );
}

function VariantRow({
  productId,
  variant,
  basePrice,
  colors,
  sizes,
  flagged,
}: {
  productId: string;
  variant: AdminVariant;
  basePrice: string;
  colors: readonly Color[];
  sizes: readonly Size[];
  /** El API rechazó el precio base nuevo por esta variante (hereda y tiene tachado ≤ precio). */
  flagged: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const base = variantToForm(variant);
  const [values, setValues] = useState(base);
  const [tried, setTried] = useState(false);
  const body = updateVariantBody(base, values);
  const dirty = Object.keys(body).length > 0;
  const clientErrors = validateVariantForm(values, basePrice);

  const save = useMutation({
    mutationFn: () => api<AdminVariant>(`/catalog/admin/variants/${variant.id}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      toast.ok(`Variante ${values.sku.trim()} guardada`);
      await qc.invalidateQueries({ queryKey: productKey(productId) });
    },
  });

  const errors = { ...(tried || dirty ? clientErrors : {}), ...serverVariantErrors(save.error) };

  return (
    <>
      <tr className={flagged ? 'bg-danger/5 outline-1 -outline-offset-1 outline-danger' : dirty ? 'bg-warn/5' : variant.status === 'inactive' ? 'opacity-70' : ''}>
        <VariantCells
          values={values}
          onChange={(v) => {
            setValues(v);
            save.reset();
          }}
          errors={errors}
          basePrice={basePrice}
          colors={colors}
          sizes={sizes}
          disabled={save.isPending}
        />
        <td className="whitespace-nowrap">
          {dirty && (
            <div className="flex gap-1">
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={save.isPending}
                onClick={() => {
                  setTried(true);
                  if (Object.keys(clientErrors).length === 0) save.mutate();
                }}
              >
                {save.isPending ? 'Guardando…' : 'Guardar'}
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={save.isPending}
                onClick={() => {
                  setValues(base);
                  save.reset();
                }}
              >
                Deshacer
              </button>
            </div>
          )}
        </td>
      </tr>
      <ErrorRow errors={errors} error={save.error} />
      {flagged && (
        <tr>
          <td colSpan={9} className="bg-danger/5 text-xs text-danger" role="alert">
            Hereda el precio base nuevo y su tachado quedaría igual o menor (rebaja falsa): quita o sube el tachado, o dale precio propio, y guarda el producto otra vez.
          </td>
        </tr>
      )}
    </>
  );
}

function NewVariantRow({
  product,
  basePrice,
  colors,
  sizes,
  onDone,
}: {
  product: AdminProductDetail;
  basePrice: string;
  colors: readonly Color[];
  sizes: readonly Size[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [values, setValues] = useState<VariantFormValues>(() => ({ ...emptyVariantForm(), sku: suggestSku(product.slug) }));
  const [skuTouched, setSkuTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const clientErrors = validateVariantForm(values, basePrice);

  const create = useMutation({
    mutationFn: () => api<AdminVariant>(`/catalog/admin/products/${product.id}/variants`, { method: 'POST', body: createVariantBody(values) }),
    onSuccess: async (v) => {
      toast.ok(`Variante ${v.sku} creada`);
      await qc.invalidateQueries({ queryKey: productKey(product.id) });
      onDone();
    },
  });

  const errors = { ...(tried ? clientErrors : {}), ...serverVariantErrors(create.error) };

  return (
    <>
      <tr className="bg-info/5">
        <VariantCells
          values={values}
          onChange={(v) => {
            create.reset();
            if (v.sku !== values.sku) setSkuTouched(true);
            if (!skuTouched && v.sku === values.sku && (v.colorId !== values.colorId || v.sizeId !== values.sizeId)) {
              const color = colors.find((c) => c.id === v.colorId)?.name;
              const size = sizes.find((s) => s.id === v.sizeId)?.code;
              v = { ...v, sku: suggestSku(product.slug, color, size) };
            }
            setValues(v);
          }}
          errors={errors}
          basePrice={basePrice}
          colors={colors}
          sizes={sizes}
          disabled={create.isPending}
        />
        <td className="whitespace-nowrap">
          <div className="flex gap-1">
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={create.isPending}
              onClick={() => {
                setTried(true);
                if (Object.keys(clientErrors).length === 0) create.mutate();
              }}
            >
              {create.isPending ? 'Creando…' : 'Crear'}
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={onDone} disabled={create.isPending}>
              Cancelar
            </button>
          </div>
        </td>
      </tr>
      <ErrorRow errors={errors} error={create.error} />
    </>
  );
}
