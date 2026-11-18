'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { productKey, useLookups, useProduct, useUnsavedChangesWarning } from '@/components/catalogo/hooks';
import { ProductForm } from '@/components/catalogo/ProductForm';
import { ProductMediaManager } from '@/components/catalogo/ProductMediaManager';
import { VariantsEditor } from '@/components/catalogo/VariantsEditor';
import { useToast } from '@/components/providers/ToastProvider';
import { StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { ErrorState } from '@/components/ui/States';
import { Spinner } from '@/components/ui/Spinner';
import { api, isApiError } from '@/lib/api/client';
import {
  type AdminProductDetail,
  compareAtError,
  inheritedPriceConflict,
  isFormDirty,
  normalizeMoney,
  mergeAfterReload,
  PRODUCT_STATUS,
  type ProductFormValues,
  productToForm,
  updateProductBody,
} from '@/lib/catalog';
import { formatDateTime } from '@/lib/format';

interface FormState {
  /** Lo que se leyó del servidor (para saber qué cambió el usuario). */
  base: ProductFormValues;
  values: ProductFormValues;
  /** updatedAt leído: se manda como expectedUpdatedAt (concurrencia optimista). */
  updatedAt: string;
}

const fromServer = (p: AdminProductDetail): FormState => ({ base: productToForm(p), values: productToForm(p), updatedAt: p.updatedAt });

/** Ficha del producto: datos generales y precios, variantes y fotos. */
export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const product = useProduct(id);
  const lookups = useLookups();
  const [form, setForm] = useState<FormState | null>(null);
  const [reloading, setReloading] = useState(false);

  const save = useMutation({
    mutationFn: (f: FormState) =>
      api<AdminProductDetail>(`/catalog/admin/products/${id}`, { method: 'PATCH', body: updateProductBody(f.base, f.values, f.updatedAt) }),
    onSuccess: async (p) => {
      qc.setQueryData(productKey(id), p);
      setForm(fromServer(p));
      toast.ok('Producto guardado');
      await qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
    },
  });

  const stale = isApiError(save.error, 'STALE_PRODUCT');
  const dirty = form ? isFormDirty(form.base, form.values) : false;

  // Sincroniza con el servidor (primera carga o refresco tras guardar variantes/fotos) solo si el
  // usuario no tiene cambios: así nunca se pierde lo tecleado.
  const data = product.data;
  if (data && (!form || (form.updatedAt !== data.updatedAt && !dirty && !stale))) setForm(fromServer(data));

  useUnsavedChangesWarning(dirty);

  /** Tras 409 STALE_PRODUCT: trae la versión nueva y conserva los campos que el usuario cambió. */
  async function reloadKeepingChanges() {
    if (!form) return;
    setReloading(true);
    try {
      const fresh = await qc.fetchQuery({
        queryKey: productKey(id),
        queryFn: ({ signal }) => api<AdminProductDetail>(`/catalog/admin/products/${id}`, { signal }),
        staleTime: 0,
      });
      const server = productToForm(fresh);
      setForm({ base: server, values: mergeAfterReload(form.base, server, form.values), updatedAt: fresh.updatedAt });
      save.reset();
      toast.info('Datos actualizados. Revisa y vuelve a guardar.');
    } catch (e) {
      toast.error(e);
    } finally {
      setReloading(false);
    }
  }

  if (product.isPending || lookups.isPending) return <div className="py-8"><Spinner label="Cargando producto…" /></div>;
  if (product.error || !data) return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  if (lookups.error || !lookups.data) return <ErrorState error={lookups.error} onRetry={() => void lookups.refetch()} />;
  if (!form) return null;

  // 422 INVALID_PRICE con details.variantIds: se marcan las variantes mientras sigan en conflicto
  // (heredan y su tachado no supera el precio rechazado); al corregirlas dejan de marcarse.
  const conflict = isApiError(save.error, 'INVALID_PRICE') ? inheritedPriceConflict(save.error.details) : null;
  const flaggedIds = new Set(
    conflict
      ? data.variants
          .filter((v) => conflict.variantIds.includes(v.id))
          .filter((v) => v.price == null && v.compareAtPrice != null && compareAtError(conflict.basePrice, normalizeMoney(v.compareAtPrice)) !== null)
          .map((v) => v.id)
      : [],
  );

  const currentUpdatedAt =stale && isApiError(save.error) ? String(save.error.details.currentUpdatedAt ?? '') : '';

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {data.name}
            <StatusBadge status={data.status} map={PRODUCT_STATUS} />
          </span>
        }
        description={
          <>
            <span className="font-mono">{data.slug}</span> · {data.category.name}
            {data.publishedAt && <> · publicado {formatDateTime(data.publishedAt)}</>} · actualizado {formatDateTime(data.updatedAt)}
          </>
        }
        back={{ href: '/catalogo/productos', label: 'Productos' }}
      />

      {stale && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm" role="alert">
          <p>
            <span className="font-semibold">Alguien más editó este producto</span>
            {currentUpdatedAt && <> ({formatDateTime(currentUpdatedAt)})</>}. Tus cambios siguen aquí: recarga los datos del servidor y vuelve a guardar.
          </p>
          <button type="button" className="btn-primary btn-sm" onClick={() => void reloadKeepingChanges()} disabled={reloading}>
            {reloading ? 'Recargando…' : 'Recargar sin perder mis cambios'}
          </button>
        </div>
      )}

      <ProductForm
        values={form.values}
        onChange={(values) => {
          setForm((f) => (f ? { ...f, values } : f));
          if (save.error && !stale) save.reset();
        }}
        lookups={lookups.data}
        onSubmit={() => {
          if (!dirty) {
            toast.info('No hay cambios que guardar');
            return;
          }
          save.mutate(form);
        }}
        submitting={save.isPending}
        submitLabel={dirty ? 'Guardar cambios' : 'Sin cambios'}
        serverError={save.error}
        disabled={reloading}
      />

      <VariantsEditor product={data} lookups={lookups.data} flaggedIds={flaggedIds} />
      <ProductMediaManager product={data} colors={lookups.data.colors} />
    </div>
  );
}
