'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '@/components/providers/ToastProvider';
import { Modal } from '@/components/ui/Modal';
import { api, errorMessage } from '@/lib/api/client';
import { type AdminProductDetail, type Color, missingCombinations, type Size, skuError } from '@/lib/catalog';
import { productKey } from './hooks';
import { Swatch } from './Swatch';

const comboKey = (colorId: string, sizeId: string) => `${colorId}|${sizeId}`;

/**
 * Generador de la matriz colores × tallas: crea en lote (una por una, con POST) las combinaciones
 * que el producto todavía no tiene, con SKU sugerido editable. Los errores quedan por fila para
 * corregir y reintentar; las creadas desaparecen de la lista al refrescar el producto.
 */
export function MatrixGenerator({
  open,
  onClose,
  product,
  colors,
  sizes,
}: {
  open: boolean;
  onClose: () => void;
  product: AdminProductDetail;
  colors: readonly Color[];
  sizes: readonly Size[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [colorIds, setColorIds] = useState<string[]>([]);
  const [sizeIds, setSizeIds] = useState<string[]>([]);
  const [skuEdits, setSkuEdits] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);

  const selColors = colors.filter((c) => colorIds.includes(c.id));
  const selSizes = sizes.filter((s) => sizeIds.includes(s.id));
  const combos = missingCombinations(product.slug, product.variants, selColors, selSizes).map((c) => {
    const key = comboKey(c.colorId, c.sizeId);
    return { ...c, key, sku: skuEdits[key] ?? c.sku };
  });
  const invalid = combos.some((c) => skuError(c.sku));
  const colorName = (id: string) => colors.find((c) => c.id === id);
  const sizeCode = (id: string) => sizes.find((s) => s.id === id)?.code ?? '';

  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  async function run() {
    setRunning({ done: 0, total: combos.length });
    const errors: Record<string, string> = {};
    let ok = 0;
    for (const [i, c] of combos.entries()) {
      try {
        await api(`/catalog/admin/products/${product.id}/variants`, { method: 'POST', body: { sku: c.sku.trim(), colorId: c.colorId, sizeId: c.sizeId } });
        ok++;
      } catch (e) {
        errors[c.key] = errorMessage(e);
      }
      setRunning({ done: i + 1, total: combos.length });
    }
    setRowErrors(errors);
    setRunning(null);
    await qc.invalidateQueries({ queryKey: productKey(product.id) });
    const failed = Object.keys(errors).length;
    if (ok > 0) toast.ok(`Se crearon ${ok} variante(s)`);
    if (failed > 0) toast.error(`${failed} variante(s) no se pudieron crear: revisa los errores`);
    else close();
  }

  function close() {
    if (running) return;
    setColorIds([]);
    setSizeIds([]);
    setSkuEdits({});
    setRowErrors({});
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Generar variantes colores × tallas"
      size="xl"
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={close} disabled={!!running}>
            Cerrar
          </button>
          <button type="button" className="btn-primary" onClick={() => void run()} disabled={!!running || combos.length === 0 || invalid}>
            {running ? `Creando ${running.done}/${running.total}…` : `Crear ${combos.length} variante(s)`}
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset>
          <legend className="label">Colores</legend>
          {colors.length === 0 ? (
            <p className="text-sm text-ink-soft">No hay colores. Créalos con “+ Color”.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {colors.map((c) => (
                <label key={c.id} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-sm ${colorIds.includes(c.id) ? 'border-ink bg-sand' : 'border-line'}`}>
                  <input type="checkbox" className="sr-only" checked={colorIds.includes(c.id)} onChange={() => toggle(colorIds, setColorIds, c.id)} />
                  <Swatch hex={c.hex} />
                  {c.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <fieldset>
          <legend className="label">Tallas</legend>
          {sizes.length === 0 ? (
            <p className="text-sm text-ink-soft">No hay tallas. Créalas con “+ Talla”.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {sizes.map((s) => (
                <label key={s.id} className={`inline-flex cursor-pointer items-center rounded-md border px-2 py-1 text-sm ${sizeIds.includes(s.id) ? 'border-ink bg-sand' : 'border-line'}`}>
                  <input type="checkbox" className="sr-only" checked={sizeIds.includes(s.id)} onChange={() => toggle(sizeIds, setSizeIds, s.id)} />
                  {s.code}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </div>

      <div className="mt-4">
        {selColors.length === 0 || selSizes.length === 0 ? (
          <p className="text-sm text-ink-soft">Elige al menos un color y una talla.</p>
        ) : combos.length === 0 ? (
          <p className="text-sm text-ink-soft">Todas esas combinaciones ya existen.</p>
        ) : (
          <div className="overflow-x-auto">
            <p className="mb-2 text-xs text-ink-soft">
              {combos.length} combinación(es) nuevas. Se crean activas y heredan el precio base; las que ya existen se omiten.
            </p>
            <table className="table-base">
              <thead>
                <tr>
                  <th>Color</th>
                  <th>Talla</th>
                  <th>SKU</th>
                </tr>
              </thead>
              <tbody>
                {combos.map((c) => {
                  const color = colorName(c.colorId);
                  const err = skuError(c.sku) ?? rowErrors[c.key];
                  return (
                    <tr key={c.key}>
                      <td>
                        <span className="inline-flex items-center gap-1.5">
                          <Swatch hex={color?.hex} />
                          {color?.name}
                        </span>
                      </td>
                      <td>{sizeCode(c.sizeId)}</td>
                      <td>
                        <input
                          aria-label={`SKU ${color?.name ?? ''} ${sizeCode(c.sizeId)}`}
                          className={`input py-1.5 font-mono ${err ? 'border-danger' : ''}`}
                          maxLength={64}
                          value={c.sku}
                          disabled={!!running}
                          onChange={(e) => {
                            setSkuEdits((s) => ({ ...s, [c.key]: e.target.value }));
                            setRowErrors((errs) => {
                              const next = { ...errs };
                              delete next[c.key];
                              return next;
                            });
                          }}
                        />
                        {err && <p className="mt-1 text-xs text-danger">{err}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
