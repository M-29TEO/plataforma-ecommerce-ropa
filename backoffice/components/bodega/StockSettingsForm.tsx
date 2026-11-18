'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '@/components/providers/ToastProvider';
import { api, isApiError } from '@/lib/api/client';
import type { StockLevel } from '@/lib/inventory';

/**
 * Reposición y ubicación de una variante en una bodega (PATCH /inventory/stock/:variantId/:warehouseId,
 * permiso inventory.stock.write) con concurrencia optimista: manda la version leída.
 */
export function StockSettingsForm({ level }: { level: StockLevel }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reorderPoint, setReorderPoint] = useState(String(level.reorderPoint));
  const [reorderQty, setReorderQty] = useState(String(level.reorderQty));
  const [binLocation, setBinLocation] = useState(level.binLocation ?? '');

  const rp = Number(reorderPoint);
  const rq = Number(reorderQty);
  const valid = Number.isInteger(rp) && rp >= 0 && Number.isInteger(rq) && rq >= 1 && binLocation.length <= 40;

  const save = useMutation({
    mutationFn: () =>
      api<StockLevel>(`/inventory/stock/${level.variantId}/${level.warehouseId}`, {
        method: 'PATCH',
        body: { version: level.version, reorderPoint: rp, reorderQty: rq, binLocation: binLocation.trim() || null },
      }),
    onSuccess: (updated) => {
      qc.setQueryData(['inventory', 'stock', 'level', level.variantId, level.warehouseId], updated);
      void qc.invalidateQueries({ queryKey: ['inventory', 'stock'] });
      toast.ok('Configuración de reposición guardada');
      setOpen(false);
    },
    onError: (e) => {
      if (isApiError(e, 'STALE_VERSION')) {
        void qc.invalidateQueries({ queryKey: ['inventory', 'stock', 'level', level.variantId, level.warehouseId] });
      }
      toast.error(e);
    },
  });

  if (!open) {
    return (
      <div className="mt-4 border-t border-line pt-3">
        <button className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
          Editar reposición y ubicación
        </button>
      </div>
    );
  }

  return (
    <form
      className="mt-4 grid gap-3 border-t border-line pt-3 sm:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <div>
        <label htmlFor="ss-rp" className="label">
          Punto de reorden
        </label>
        <input id="ss-rp" className="input" type="number" inputMode="numeric" min={0} required value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} />
      </div>
      <div>
        <label htmlFor="ss-rq" className="label">
          Cantidad a reponer
        </label>
        <input id="ss-rq" className="input" type="number" inputMode="numeric" min={1} required value={reorderQty} onChange={(e) => setReorderQty(e.target.value)} />
      </div>
      <div>
        <label htmlFor="ss-bin" className="label">
          Ubicación (percha / estante)
        </label>
        <input id="ss-bin" className="input" maxLength={40} value={binLocation} onChange={(e) => setBinLocation(e.target.value)} />
      </div>
      <div className="flex items-end gap-2">
        <button type="submit" className="btn-primary" disabled={!valid || save.isPending}>
          {save.isPending ? 'Guardando…' : 'Guardar'}
        </button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
          Cerrar
        </button>
      </div>
    </form>
  );
}
