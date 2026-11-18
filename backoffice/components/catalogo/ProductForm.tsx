'use client';

import { useState } from 'react';
import { errorMessage, isApiError } from '@/lib/api/client';
import {
  categoryOptions,
  GENDER_LABEL,
  GENDERS,
  inheritedPriceConflict,
  type Lookups,
  marginRatio,
  PRODUCT_STATUS,
  PRODUCT_STATUSES,
  type ProductFormErrors,
  type ProductFormValues,
  type ProductStatus,
  slugify,
  TAX_CODES,
  validateProductForm,
} from '@/lib/catalog';
import { formatPercent } from '@/lib/format';
import { CreateLookupModal, type LookupKind } from './CreateLookupModal';

/** Campo del formulario al que apunta un error del API (para mostrarlo junto al input). */
function serverFieldErrors(error: unknown): ProductFormErrors {
  if (!isApiError(error)) return {};
  const msg = errorMessage(error);
  switch (error.code) {
    case 'SLUG_TAKEN':
      return { slug: msg };
    case 'INVALID_PRICE': {
      const conflict = inheritedPriceConflict(error.details);
      return conflict
        ? {
            basePrice: `Con este precio, ${conflict.variantIds.length} variante(s) que lo heredan quedarían con el tachado igual o menor al precio (rebaja falsa). Corrige su tachado en la tabla de variantes (marcadas) o elige otro precio.`,
          }
        : { compareAtPrice: msg };
    }
    case 'UNKNOWN_TAX_CODE':
      return { taxCode: msg };
    case 'INVALID_REFERENCE': {
      const field = String(error.details.field ?? '');
      return field === 'categoryId' || field === 'brandId' || field === 'sizeChartId' ? { [field]: msg } : {};
    }
    default:
      return {};
  }
}

const STATUS_HINT: Record<ProductStatus, string> = {
  draft: 'No se ve en la tienda.',
  active: 'Visible en la tienda (al publicarlo se registra la fecha).',
  archived: 'Retirado de la tienda; se conserva el historial.',
};

/**
 * Formulario de producto (alta y edición): datos generales, precios con margen, impuesto y estado.
 * Controlado: el padre guarda `values`. Valida en el cliente antes de llamar a onSubmit.
 */
export function ProductForm({
  values,
  onChange,
  lookups,
  onSubmit,
  submitting,
  submitLabel,
  serverError,
  autoSlug = false,
  disabled = false,
}: {
  values: ProductFormValues;
  onChange: (v: ProductFormValues) => void;
  lookups: Lookups;
  onSubmit: () => void;
  submitting: boolean;
  submitLabel: string;
  serverError?: unknown;
  /** Alta: el slug sigue al nombre hasta que el usuario lo edite. */
  autoSlug?: boolean;
  disabled?: boolean;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [slugTouched, setSlugTouched] = useState(!autoSlug);
  const [creating, setCreating] = useState<LookupKind | null>(null);

  const clientErrors = validateProductForm(values);
  const errors: ProductFormErrors = { ...(submitted ? clientErrors : {}), ...serverFieldErrors(serverError) };
  const margin = marginRatio(values.basePrice, values.cost);
  const set = <K extends keyof ProductFormValues>(k: K, v: ProductFormValues[K]) => onChange({ ...values, [k]: v });

  const field = (k: keyof ProductFormValues) => ({
    id: `pf-${k}`,
    'aria-invalid': errors[k] ? true : undefined,
    'aria-describedby': errors[k] ? `pf-${k}-err` : undefined,
  });
  const err = (k: keyof ProductFormValues) =>
    errors[k] ? (
      <p id={`pf-${k}-err`} className="mt-1 text-xs text-danger">{errors[k]}</p>
    ) : null;

  const brands = lookups.brands.filter((b) => b.active || b.id === values.brandId);
  const categories = categoryOptions(lookups.categories).filter((c) => c.active || c.id === values.categoryId);

  return (
    <>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (Object.keys(clientErrors).length === 0) onSubmit();
        }}
      >
        <fieldset disabled={disabled || submitting} className="space-y-4">
          <section className="card p-4">
            <h2 className="mb-3 text-sm font-semibold">Datos generales</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="label" htmlFor="pf-name">Nombre *</label>
                <input
                  {...field('name')}
                  className="input"
                  required
                  maxLength={200}
                  value={values.name}
                  onChange={(e) => {
                    const name = e.target.value;
                    onChange({ ...values, name, slug: slugTouched ? values.slug : slugify(name) });
                  }}
                />
                {err('name')}
              </div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor="pf-slug">Slug (URL en la tienda)</label>
                <div className="flex gap-2">
                  <input
                    {...field('slug')}
                    className="input font-mono"
                    maxLength={120}
                    placeholder={slugify(values.name) || 'vestido-floral'}
                    value={values.slug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      set('slug', e.target.value);
                    }}
                  />
                  <button
                    type="button"
                    className="btn-ghost btn-sm shrink-0"
                    disabled={!values.name.trim() || slugify(values.name) === values.slug}
                    onClick={() => set('slug', slugify(values.name))}
                  >
                    Sugerir
                  </button>
                </div>
                {err('slug') ?? <p className="mt-1 text-xs text-ink-soft">Minúsculas, números y guiones.{autoSlug && ' Si lo dejas vacío se genera del nombre.'}</p>}
              </div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor="pf-description">Descripción</label>
                <textarea {...field('description')} className="input min-h-24" maxLength={10000} value={values.description} onChange={(e) => set('description', e.target.value)} />
              </div>
              <div>
                <div className="flex items-end justify-between">
                  <label className="label" htmlFor="pf-categoryId">Categoría *</label>
                  <button type="button" className="mb-1 text-xs text-accent hover:underline" onClick={() => setCreating('category')}>+ Nueva</button>
                </div>
                <select {...field('categoryId')} className="input" required value={values.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                  <option value="">Elige…</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}{c.active ? '' : ' (inactiva)'}</option>
                  ))}
                </select>
                {err('categoryId')}
              </div>
              <div>
                <div className="flex items-end justify-between">
                  <label className="label" htmlFor="pf-brandId">Marca</label>
                  <button type="button" className="mb-1 text-xs text-accent hover:underline" onClick={() => setCreating('brand')}>+ Nueva</button>
                </div>
                <select {...field('brandId')} className="input" value={values.brandId} onChange={(e) => set('brandId', e.target.value)}>
                  <option value="">Sin marca</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}{b.active ? '' : ' (inactiva)'}</option>
                  ))}
                </select>
                {err('brandId')}
              </div>
              <div>
                <label className="label" htmlFor="pf-gender">Género *</label>
                <select {...field('gender')} className="input" required value={values.gender} onChange={(e) => set('gender', e.target.value as ProductFormValues['gender'])}>
                  <option value="">Elige…</option>
                  {GENDERS.map((g) => (
                    <option key={g} value={g}>{GENDER_LABEL[g]}</option>
                  ))}
                </select>
                {err('gender')}
              </div>
              <div>
                <label className="label" htmlFor="pf-sizeChartId">Guía de tallas</label>
                <select {...field('sizeChartId')} className="input" value={values.sizeChartId} onChange={(e) => set('sizeChartId', e.target.value)}>
                  <option value="">Sin guía</option>
                  {lookups.sizeCharts.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                {err('sizeChartId')}
              </div>
              <div>
                <label className="label" htmlFor="pf-season">Temporada</label>
                <input {...field('season')} className="input" maxLength={60} placeholder="Verano 2026" value={values.season} onChange={(e) => set('season', e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="pf-material">Material</label>
                <input {...field('material')} className="input" maxLength={300} placeholder="100 % algodón" value={values.material} onChange={(e) => set('material', e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor="pf-careInstructions">Cuidado</label>
                <textarea
                  {...field('careInstructions')}
                  className="input min-h-16"
                  maxLength={2000}
                  placeholder="Lavar a mano con agua fría"
                  value={values.careInstructions}
                  onChange={(e) => set('careInstructions', e.target.value)}
                />
              </div>
            </div>
            <p className="mt-3 text-xs text-ink-soft">
              ¿Falta un color o una talla para las variantes?{' '}
              <button type="button" className="text-accent hover:underline" onClick={() => setCreating('color')}>Crear color</button>
              {' · '}
              <button type="button" className="text-accent hover:underline" onClick={() => setCreating('size')}>Crear talla</button>
            </p>
          </section>

          <section className="card p-4">
            <h2 className="mb-3 text-sm font-semibold">Precios (USD)</h2>
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <label className="label" htmlFor="pf-basePrice">Precio base *</label>
                <input {...field('basePrice')} className="input num" inputMode="decimal" required placeholder="0.00" value={values.basePrice} onChange={(e) => set('basePrice', e.target.value)} />
                {err('basePrice')}
              </div>
              <div>
                <label className="label" htmlFor="pf-compareAtPrice">Precio tachado (antes)</label>
                <input {...field('compareAtPrice')} className="input num" inputMode="decimal" placeholder="Sin tachado" value={values.compareAtPrice} onChange={(e) => set('compareAtPrice', e.target.value)} />
                {err('compareAtPrice')}
              </div>
              <div>
                <label className="label" htmlFor="pf-cost">Costo</label>
                <input {...field('cost')} className="input num" inputMode="decimal" placeholder="0.00" value={values.cost} onChange={(e) => set('cost', e.target.value)} />
                {err('cost')}
              </div>
              <div>
                <span className="label">Margen</span>
                <p className={`py-2 text-sm font-semibold tabular-nums ${margin !== null && margin < 0 ? 'text-danger' : ''}`} aria-live="polite">
                  {margin === null ? '—' : formatPercent(margin)}
                </p>
              </div>
            </div>
            <p className="mt-2 text-xs text-ink-soft">Margen = (precio base − costo) / precio base. Los precios incluyen IVA si así se publican en la tienda.</p>
          </section>

          <section className="card p-4">
            <h2 className="mb-3 text-sm font-semibold">Impuesto y estado</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="pf-taxCode">IVA (código SRI)</label>
                <select {...field('taxCode')} className="input" value={values.taxCode} onChange={(e) => set('taxCode', e.target.value)}>
                  {!TAX_CODES.some((t) => t.code === values.taxCode) && <option value={values.taxCode}>Código {values.taxCode}</option>}
                  {TAX_CODES.map((t) => (
                    <option key={t.code} value={t.code}>{t.code} · {t.label}</option>
                  ))}
                </select>
                {err('taxCode')}
              </div>
              <div>
                <label className="label" htmlFor="pf-status">Estado</label>
                <select {...field('status')} className="input" value={values.status} onChange={(e) => set('status', e.target.value as ProductStatus)}>
                  {PRODUCT_STATUSES.map((s) => (
                    <option key={s} value={s}>{PRODUCT_STATUS[s][0]}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-ink-soft">{STATUS_HINT[values.status]}</p>
              </div>
            </div>
          </section>
        </fieldset>

        {serverError != null && Object.keys(serverFieldErrors(serverError)).length === 0 && !isApiError(serverError, 'STALE_PRODUCT') && (
          <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">{errorMessage(serverError)}</p>
        )}
        {submitted && Object.keys(clientErrors).length > 0 && (
          <p className="text-sm text-danger" role="alert">Revisa los campos marcados.</p>
        )}

        <div className="flex justify-end">
          <button type="submit" className="btn-primary" disabled={disabled || submitting}>
            {submitting ? 'Guardando…' : submitLabel}
          </button>
        </div>
      </form>

      <CreateLookupModal
        kind={creating}
        categories={lookups.categories}
        onClose={() => setCreating(null)}
        onCreated={(kind, id) => {
          setCreating(null);
          if (kind === 'brand') set('brandId', id);
          if (kind === 'category') set('categoryId', id);
        }}
      />
    </>
  );
}
