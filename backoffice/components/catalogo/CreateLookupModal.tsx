'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useToast } from '@/components/providers/ToastProvider';
import { Modal } from '@/components/ui/Modal';
import { api, errorMessage } from '@/lib/api/client';
import { type Category, categoryOptions, SIZE_SYSTEM_LABEL, SIZE_SYSTEMS, type SizeSystem } from '@/lib/catalog';
import { LOOKUPS_KEY } from './hooks';

export type LookupKind = 'brand' | 'category' | 'color' | 'size';

const TITLE: Record<LookupKind, string> = {
  brand: 'Nueva marca',
  category: 'Nueva categoría',
  color: 'Nuevo color',
  size: 'Nueva talla',
};

const CREATED: Record<LookupKind, string> = {
  brand: 'Marca creada',
  category: 'Categoría creada',
  color: 'Color creado',
  size: 'Talla creada',
};

const PATH: Record<LookupKind, string> = {
  brand: '/catalog/admin/brands',
  category: '/catalog/admin/categories',
  color: '/catalog/admin/colors',
  size: '/catalog/admin/sizes',
};

/**
 * Alta al vuelo de marca, categoría, color o talla desde el formulario. Al crearla refresca los
 * lookups y devuelve el id para dejarla seleccionada. Se monta FUERA de cualquier <form>.
 */
export function CreateLookupModal({
  kind,
  categories = [],
  onClose,
  onCreated,
}: {
  kind: LookupKind | null;
  categories?: readonly Category[];
  onClose: () => void;
  onCreated: (kind: LookupKind, id: string) => void;
}) {
  return (
    <Modal open={kind !== null} onClose={onClose} title={kind ? TITLE[kind] : ''} size="sm">
      {kind && <LookupForm key={kind} kind={kind} categories={categories} onClose={onClose} onCreated={onCreated} />}
    </Modal>
  );
}

function LookupForm({
  kind,
  categories,
  onClose,
  onCreated,
}: {
  kind: LookupKind;
  categories: readonly Category[];
  onClose: () => void;
  onCreated: (kind: LookupKind, id: string) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [hex, setHex] = useState('#000000');
  const [withHex, setWithHex] = useState(true);
  const [sizeSystem, setSizeSystem] = useState<SizeSystem>('alpha');
  const [sortOrder, setSortOrder] = useState('0');

  const create = useMutation({
    mutationFn: () => {
      const body =
        kind === 'brand'
          ? { name }
          : kind === 'category'
            ? { name, parentId: parentId || null }
            : kind === 'color'
              ? { name, hex: withHex ? hex : null }
              : { code: name, sizeSystem, sortOrder: Number(sortOrder) || 0 };
      return api<{ id: string }>(PATH[kind], { method: 'POST', body });
    },
    onSuccess: async (row) => {
      await qc.invalidateQueries({ queryKey: LOOKUPS_KEY });
      toast.ok(CREATED[kind]);
      onCreated(kind, row.id);
    },
  });

  const nameLabel = kind === 'size' ? 'Código (p. ej. M, 32, 38)' : 'Nombre';
  const maxLength = kind === 'size' ? 20 : kind === 'color' ? 60 : 100;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      <div>
        <label className="label" htmlFor={`${id}-name`}>{nameLabel}</label>
        <input id={`${id}-name`} className="input" required maxLength={maxLength} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>

      {kind === 'category' && (
        <div>
          <label className="label" htmlFor={`${id}-parent`}>Categoría padre</label>
          <select id={`${id}-parent`} className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">(ninguna: categoría principal)</option>
            {categoryOptions(categories).map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
      )}

      {kind === 'color' && (
        <div className="flex items-end gap-3">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={withHex} onChange={(e) => setWithHex(e.target.checked)} />
            Muestra de color
          </label>
          {withHex && (
            <div className="flex items-center gap-2">
              <label className="sr-only" htmlFor={`${id}-hex`}>Color</label>
              <input id={`${id}-hex`} type="color" className="h-9 w-12 cursor-pointer rounded border border-line" value={hex} onChange={(e) => setHex(e.target.value)} />
              <span className="font-mono text-xs text-ink-soft">{hex}</span>
            </div>
          )}
        </div>
      )}

      {kind === 'size' && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor={`${id}-sys`}>Sistema</label>
            <select id={`${id}-sys`} className="input" value={sizeSystem} onChange={(e) => setSizeSystem(e.target.value as SizeSystem)}>
              {SIZE_SYSTEMS.map((s) => (
                <option key={s} value={s}>{SIZE_SYSTEM_LABEL[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`${id}-order`}>Orden</label>
            <input id={`${id}-order`} type="number" min={0} max={10000} className="input" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </div>
        </div>
      )}

      {create.error && (
        <p className="text-sm text-danger" role="alert">{errorMessage(create.error)}</p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="btn-ghost" onClick={onClose} disabled={create.isPending}>Cancelar</button>
        <button type="submit" className="btn-primary" disabled={create.isPending || !name.trim()}>
          {create.isPending ? 'Creando…' : 'Crear'}
        </button>
      </div>
    </form>
  );
}
