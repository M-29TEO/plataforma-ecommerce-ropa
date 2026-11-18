'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { useToast } from '@/components/providers/ToastProvider';
import { EmptyState } from '@/components/ui/States';
import { api, errorMessage } from '@/lib/api/client';
import { type AdminProductDetail, type Color, MEDIA_MAX_BYTES, MEDIA_TYPES, type ProductMedia, reorderMedia } from '@/lib/catalog';
import { productKey } from './hooks';
import { Swatch } from './Swatch';

/** Error de un archivo antes de subirlo (el API vuelve a validar: 422 MEDIA_TYPE / MEDIA_TOO_LARGE). */
function fileError(f: File): string | null {
  if (!(MEDIA_TYPES as readonly string[]).includes(f.type)) return 'Debe ser JPG, PNG o WEBP';
  if (f.size > MEDIA_MAX_BYTES) return 'Supera 5 MB';
  return null;
}

/** Texto alternativo editable: se guarda al salir del campo o con Enter (si cambió). */
function AltTextInput({
  value,
  onCommit,
  label,
  placeholder,
  disabled,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  placeholder: string;
  disabled: boolean;
}) {
  const [text, setText] = useState(value);
  const commit = () => {
    if (text.trim() !== value) onCommit(text.trim());
  };
  return (
    <input
      aria-label={label}
      className="input px-1.5 py-1 text-xs"
      maxLength={200}
      placeholder={placeholder}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') setText(value);
      }}
    />
  );
}

/**
 * Fotos del producto: subir varias (una petición multipart por archivo) asignando color y texto
 * alternativo; luego cambiar color y texto, reordenar (← →) y borrar con confirmación.
 */
export function ProductMediaManager({ product, colors }: { product: AdminProductDetail; colors: readonly Color[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [colorId, setColorId] = useState('');
  const [altText, setAltText] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<{ name: string; error: string }[]>([]);
  const [toDelete, setToDelete] = useState<ProductMedia | null>(null);

  const colorById = new Map(colors.map((c) => [c.id, c]));
  const media = [...product.media].sort((a, b) => a.sortOrder - b.sortOrder);

  async function upload(files: File[]) {
    const fails: { name: string; error: string }[] = [];
    const valid: File[] = [];
    for (const f of files) {
      const e = fileError(f);
      if (e) fails.push({ name: f.name, error: e });
      else valid.push(f);
    }
    let ok = 0;
    setProgress({ done: 0, total: valid.length });
    for (const [i, f] of valid.entries()) {
      const form = new FormData();
      form.append('file', f);
      if (colorId) form.append('colorId', colorId);
      const alt = altText.trim() || product.name;
      form.append('altText', alt.slice(0, 200));
      try {
        await api<ProductMedia>(`/catalog/admin/products/${product.id}/media`, { method: 'POST', form });
        ok++;
      } catch (e) {
        fails.push({ name: f.name, error: errorMessage(e) });
      }
      setProgress({ done: i + 1, total: valid.length });
    }
    setProgress(null);
    setFailures(fails);
    if (inputRef.current) inputRef.current.value = '';
    if (ok > 0) {
      toast.ok(`${ok} foto(s) subida(s)`);
      await qc.invalidateQueries({ queryKey: productKey(product.id) });
    }
  }

  /** PATCH /catalog/admin/media/:id (color, texto alternativo u orden). */
  const update = useMutation({
    mutationFn: (changes: { id: string; body: { colorId?: string | null; altText?: string | null; sortOrder?: number } }[]) =>
      Promise.all(changes.map((c) => api<ProductMedia>(`/catalog/admin/media/${c.id}`, { method: 'PATCH', body: c.body }))),
    onError: (e) => toast.error(e),
    // Aunque falle a medias (reordenar son varios PATCH), se relee el estado real.
    onSettled: () => qc.invalidateQueries({ queryKey: productKey(product.id) }),
  });

  const move = (id: string, dir: -1 | 1) => {
    const changes = reorderMedia(media, id, dir);
    if (changes.length) update.mutate(changes.map((c) => ({ id: c.id, body: { sortOrder: c.sortOrder } })));
  };

  const remove = useMutation({
    mutationFn: (id: string) => api(`/catalog/admin/media/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.ok('Foto eliminada');
      setToDelete(null);
      await qc.invalidateQueries({ queryKey: productKey(product.id) });
    },
    onError: (e) => toast.error(e),
  });

  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-semibold">Fotos ({media.length})</h2>

      <div className="mb-4 grid gap-3 rounded-md bg-sand/50 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <label className="label" htmlFor="media-color">Color de las fotos</label>
          <select id="media-color" className="input" value={colorId} onChange={(e) => setColorId(e.target.value)} disabled={!!progress}>
            <option value="">Todas las variantes (sin color)</option>
            {colors.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="media-alt">Texto alternativo</label>
          <input id="media-alt" className="input" maxLength={200} placeholder={product.name} value={altText} onChange={(e) => setAltText(e.target.value)} disabled={!!progress} />
        </div>
        <div>
          <input
            ref={inputRef}
            id="media-file"
            type="file"
            accept={MEDIA_TYPES.join(',')}
            multiple
            className="sr-only"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) void upload(files);
            }}
          />
          <label htmlFor="media-file" className={`btn-primary w-full cursor-pointer ${progress ? 'pointer-events-none opacity-50' : ''}`} aria-disabled={!!progress}>
            {progress ? `Subiendo ${progress.done}/${progress.total}…` : 'Subir fotos'}
          </label>
        </div>
        <p className="text-xs text-ink-soft sm:col-span-3">JPG, PNG o WEBP de hasta 5 MB. Puedes elegir varias a la vez; el color y el texto se pueden cambiar después en cada foto.</p>
      </div>

      {failures.length > 0 && (
        <ul className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">
          {failures.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span className="font-medium">{f.name}</span>: {f.error}
            </li>
          ))}
        </ul>
      )}

      {media.length === 0 ? (
        <EmptyState title="Sin fotos">Sube al menos una para publicar el producto con imagen.</EmptyState>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {media.map((m, i) => {
            const color = m.colorId ? colorById.get(m.colorId) : undefined;
            const busy = update.isPending;
            return (
              <li key={m.id} className="overflow-hidden rounded-md border border-line">
                {/* eslint-disable-next-line @next/next/no-img-element -- fotos del API sin optimizador de next/image */}
                <img src={m.url} alt={m.altText ?? product.name} className="aspect-[3/4] w-full bg-sand object-cover" loading="lazy" />
                <div className="space-y-1.5 px-2 py-1.5 text-xs">
                  <div className="flex items-center gap-1">
                    <Swatch hex={color?.hex} />
                    <select
                      aria-label={`Color de la foto ${i + 1}`}
                      className="input min-w-0 px-1.5 py-1 text-xs"
                      value={m.colorId ?? ''}
                      disabled={busy}
                      onChange={(e) => update.mutate([{ id: m.id, body: { colorId: e.target.value || null } }])}
                    >
                      <option value="">Sin color</option>
                      {colors.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                  <AltTextInput
                    key={m.altText ?? ''}
                    label={`Texto alternativo de la foto ${i + 1}`}
                    value={m.altText ?? ''}
                    placeholder={product.name}
                    disabled={busy}
                    onCommit={(altText) => update.mutate([{ id: m.id, body: { altText: altText || null } }])}
                  />
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex gap-1">
                      <button type="button" className="btn-ghost btn-sm px-2" aria-label={`Mover la foto ${i + 1} antes`} disabled={busy || i === 0} onClick={() => move(m.id, -1)}>
                        ←
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-sm px-2"
                        aria-label={`Mover la foto ${i + 1} después`}
                        disabled={busy || i === media.length - 1}
                        onClick={() => move(m.id, 1)}
                      >
                        →
                      </button>
                    </div>
                    <button type="button" className="text-danger hover:underline" onClick={() => setToDelete(m)}>
                      Borrar
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title="Borrar foto"
        confirmLabel="Borrar"
        busy={remove.isPending}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      >
        <p>La foto se quitará del producto y de la tienda. Esta acción no se puede deshacer.</p>
      </ConfirmDialog>
    </section>
  );
}
