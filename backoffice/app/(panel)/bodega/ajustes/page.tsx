'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MovementsTable } from '@/components/bodega/MovementsTable';
import { StockSettingsForm } from '@/components/bodega/StockSettingsForm';
import { WarehouseSelect } from '@/components/bodega/shared';
import { useCan } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/providers/ToastProvider';
import { VariantPicker } from '@/components/scanner/VariantPicker';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { ErrorState } from '@/components/ui/States';
import { Spinner } from '@/components/ui/Spinner';
import { api, isApiError } from '@/lib/api/client';
import { formatInt } from '@/lib/format';
import {
  ADJUSTMENT_TYPES,
  adjustmentBody,
  type AdjustmentType,
  previewAdjustment,
  REASON_SUGGESTIONS,
  signed,
  type StockLevel,
  stockTone,
  validReason,
} from '@/lib/inventory';
import { variantLabel, type VariantLookupItem } from '@/lib/scanner';

/**
 * Ajustes de stock (permiso inventory.adjust): elegir bodega, escanear o buscar la prenda, ver su
 * stock y registrar una corrección, merma o conteo físico con motivo. Debajo, los movimientos.
 */
export default function AdjustmentsPage() {
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const [warehouseId, setWarehouseId] = useState('');
  const [variant, setVariant] = useState<VariantLookupItem | null>(null);
  const [type, setType] = useState<AdjustmentType>('adjustment');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);

  const level = useQuery({
    queryKey: ['inventory', 'stock', 'level', variant?.variantId, warehouseId],
    queryFn: async ({ signal }) => {
      try {
        return await api<StockLevel>(`/inventory/stock/${variant!.variantId}/${warehouseId}`, { signal });
      } catch (e) {
        // Sin fila de stock en esa bodega = 0 unidades (el ajuste la crea).
        if (isApiError(e, 'STOCK_LEVEL_NOT_FOUND')) return null;
        throw e;
      }
    },
    enabled: Boolean(variant && warehouseId),
  });

  const n = qty.trim() === '' ? NaN : Number(qty);
  const preview = Number.isNaN(n) ? null : previewAdjustment(level.data ?? null, type, n);
  const canSubmit = Boolean(variant && warehouseId && preview && !preview.error && validReason(reason) && level.isSuccess);

  const adjust = useMutation({
    mutationFn: () =>
      api<{ level: StockLevel; delta: number }>('/inventory/stock/adjustments', {
        method: 'POST',
        body: adjustmentBody({ variantId: variant!.variantId, warehouseId, type, qty: n, reason }),
      }),
    onSuccess: (r) => {
      qc.setQueryData(['inventory', 'stock', 'level', variant?.variantId, warehouseId], r.level);
      void qc.invalidateQueries({ queryKey: ['inventory', 'stock'] });
      toast.ok(`Ajuste registrado (${signed(r.delta)}). Stock físico: ${r.level.onHand}`);
      setQty('');
      setReason('');
      setConfirming(false);
    },
    onError: (e) => {
      setConfirming(false);
      toast.error(e);
    },
  });

  const typeInfo = ADJUSTMENT_TYPES.find((t) => t.value === type)!;

  return (
    <div className="max-w-4xl">
      <PageHeader title="Ajustes de stock" description="Conteos físicos, mermas y correcciones. Cada ajuste queda registrado con tu usuario y el motivo." />

      <section className="card mb-4 grid gap-4 p-4 sm:grid-cols-[minmax(0,14rem)_1fr]">
        <WarehouseSelect value={warehouseId} onChange={setWarehouseId} />
        <VariantPicker onSelect={setVariant} label="Prenda (escanea, SKU o nombre)" />
      </section>

      {variant && warehouseId && (
        <section className="card mb-6 p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{variantLabel(variant)}</p>
              <p className="font-mono text-xs text-ink-soft">
                {variant.sku}
                {variant.barcode ? ` · ${variant.barcode}` : ''}
              </p>
            </div>
            <button className="btn-ghost btn-sm" onClick={() => setVariant(null)}>
              Cambiar prenda
            </button>
          </div>

          {level.isPending ? (
            <Spinner />
          ) : level.error ? (
            <ErrorState error={level.error} onRetry={() => void level.refetch()} />
          ) : (
            <>
              <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ['Físico', level.data?.onHand ?? 0],
                  ['Reservado', level.data?.reserved ?? 0],
                  ['Disponible', level.data?.available ?? 0],
                  ['Punto de reorden', level.data?.reorderPoint ?? 0],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded-md bg-sand/50 px-3 py-2">
                    <dt className="text-xs text-ink-soft">{k}</dt>
                    <dd className="text-lg font-semibold tabular-nums">{formatInt(v)}</dd>
                  </div>
                ))}
              </dl>
              {level.data ? (
                <p className="mb-4 text-xs text-ink-soft">
                  <Badge tone={stockTone(level.data)[1]}>{stockTone(level.data)[0]}</Badge>
                  {level.data.binLocation && <> · Ubicación {level.data.binLocation}</>}
                </p>
              ) : (
                <p className="mb-4 text-xs text-ink-soft">Esta prenda aún no tiene stock en la bodega: el ajuste crea el registro.</p>
              )}

              <form
                className="grid gap-3 sm:grid-cols-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSubmit) setConfirming(true);
                }}
              >
                <fieldset className="sm:col-span-3">
                  <legend className="label">Tipo de ajuste</legend>
                  <div className="flex flex-wrap gap-2">
                    {ADJUSTMENT_TYPES.map((t) => (
                      <label key={t.value} className={`btn-sm cursor-pointer ${type === t.value ? 'btn-primary' : 'btn-ghost'}`}>
                        <input type="radio" name="adj-type" value={t.value} checked={type === t.value} onChange={() => setType(t.value)} className="sr-only" />
                        {t.label}
                      </label>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-ink-soft">{typeInfo.help}</p>
                </fieldset>
                <div>
                  <label htmlFor="adj-qty" className="label">
                    {typeInfo.qtyLabel}
                  </label>
                  <input
                    id="adj-qty"
                    className="input text-right tabular-nums"
                    type="text"
                    inputMode={type === 'adjustment' ? 'text' : 'numeric'}
                    pattern="-?[0-9]*"
                    autoComplete="off"
                    required
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    placeholder={type === 'adjustment' ? 'p. ej. -2 o 3' : '0'}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="adj-reason" className="label">
                    Motivo (obligatorio)
                  </label>
                  <input
                    id="adj-reason"
                    className="input"
                    required
                    minLength={3}
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    list="adj-reasons"
                  />
                  <datalist id="adj-reasons">
                    {REASON_SUGGESTIONS.map((r) => (
                      <option key={r} value={r} />
                    ))}
                  </datalist>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-3">
                  <p className={`text-sm ${preview?.error ? 'text-danger' : 'text-ink-soft'}`} aria-live="polite">
                    {preview
                      ? preview.error ?? `Diferencia ${signed(preview.delta)} → quedarán ${formatInt(preview.newOnHand)} unidades físicas`
                      : 'Ingresa la cantidad'}
                  </p>
                  <button type="submit" className="btn-accent" disabled={!canSubmit}>
                    Registrar ajuste
                  </button>
                </div>
              </form>

              {level.data && can('inventory.stock.write') && <StockSettingsForm key={`${level.data.variantId}:${level.data.warehouseId}`} level={level.data} />}
            </>
          )}
        </section>
      )}

      <h2 className="mb-2 text-base font-semibold">Movimientos recientes{variant ? ` de ${variant.sku}` : ''}</h2>
      {warehouseId ? (
        <MovementsTable warehouseId={warehouseId} variantId={variant?.variantId} />
      ) : (
        <p className="text-sm text-ink-soft">Elige una bodega.</p>
      )}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Confirmar ajuste"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setConfirming(false)}>
              Volver
            </button>
            <button className="btn-accent" disabled={adjust.isPending} onClick={() => adjust.mutate()}>
              {adjust.isPending ? 'Registrando…' : 'Registrar'}
            </button>
          </>
        }
      >
        {variant && preview && (
          <div className="space-y-1 text-sm">
            <p>
              <strong>{typeInfo.label}</strong> de {variantLabel(variant)} ({variant.sku})
            </p>
            <p>
              Stock físico: {formatInt(level.data?.onHand ?? 0)} → <strong>{formatInt(preview.newOnHand)}</strong> ({signed(preview.delta)})
            </p>
            <p className="text-ink-soft">Motivo: {reason.trim()}</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
