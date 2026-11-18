'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useLookups, useUnsavedChangesWarning } from '@/components/catalogo/hooks';
import { ProductForm } from '@/components/catalogo/ProductForm';
import { useToast } from '@/components/providers/ToastProvider';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryState } from '@/components/ui/States';
import { api } from '@/lib/api/client';
import { type AdminProductDetail, createProductBody, EMPTY_PRODUCT_FORM, isFormDirty, type ProductFormValues } from '@/lib/catalog';

/** Alta de producto. Al crearlo se abre su ficha para agregar variantes y fotos. */
export default function NewProductPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const lookups = useLookups();
  const [values, setValues] = useState<ProductFormValues>(EMPTY_PRODUCT_FORM);

  const create = useMutation({
    mutationFn: () => api<AdminProductDetail>('/catalog/admin/products', { method: 'POST', body: createProductBody(values) }),
    onSuccess: async (p) => {
      qc.setQueryData(['catalog', 'product', p.id], p);
      await qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
      toast.ok('Producto creado. Ahora agrega sus variantes y fotos.');
      router.push(`/catalogo/productos/${p.id}`);
    },
  });

  useUnsavedChangesWarning(isFormDirty(EMPTY_PRODUCT_FORM, values) && !create.isSuccess);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Nuevo producto" description="Primero los datos generales y el precio; luego variantes y fotos" back={{ href: '/catalogo/productos', label: 'Productos' }} />
      <QueryState query={lookups} loading="Cargando catálogos…">
        {(data) => (
          <ProductForm
            values={values}
            onChange={(v) => {
              setValues(v);
              if (create.error) create.reset();
            }}
            lookups={data}
            autoSlug
            onSubmit={() => create.mutate()}
            submitting={create.isPending || create.isSuccess}
            submitLabel="Crear producto"
            serverError={create.error}
          />
        )}
      </QueryState>
    </div>
  );
}
