'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { VariantPicker } from '@/components/scanner/VariantPicker';
import { useToast } from '@/components/providers/ToastProvider';
import { Modal } from '@/components/ui/Modal';
import { api, errorMessage } from '@/lib/api/client';
import { formatMoney } from '@/lib/format';
import { normalizeUnitCost, type PurchaseOrder } from '@/lib/inventory';
import { variantLabel, type VariantLookupItem } from '@/lib/scanner';
import { useSuppliers, WarehouseSelect } from './shared';

interface Line {
  variant: VariantLookupItem;
  qty: string;
  cost: string;
}

/**
 * Alta de una orden de compra (POST /inventory/purchase-orders, permiso inventory.purchase.write).
 * Se crea en borrador; desde el detalle se envía al proveedor.
 */
export function CreatePurchaseOrderModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const suppliers = useSuppliers();
  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [number, setNumber] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState('');

  function addVariant(v: VariantLookupItem) {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.variant.variantId === v.variantId);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, qty: String((Number(l.qty) || 0) + 1) } : l));
      return [...ls, { variant: v, qty: '1', cost: '' }];
    });
  }

  const parsed = lines.map((l) => ({ qty: Number(l.qty), cost: normalizeUnitCost(l.cost) }));
  const valid =
    supplierId !== '' &&
    warehouseId !== '' &&
    lines.length > 0 &&
    parsed.every((p) => Number.isInteger(p.qty) && p.qty >= 1 && p.qty <= 100_000 && p.cost !== null);
  const total = parsed.reduce((s, p) => s + (p.cost ? Number(p.cost) * (p.qty || 0) : 0), 0);

  const create = useMutation({
    mutationFn: () =>
      api<PurchaseOrder>('/inventory/purchase-orders', {
        method: 'POST',
        body: {
          supplierId,
          warehouseId,
          number: number.trim() || undefined,
          expectedAt: expectedAt || undefined,
          items: lines.map((l, i) => ({ variantId: l.variant.variantId, qtyOrdered: parsed[i].qty, unitCost: parsed[i].cost })),
        },
      }),
    onSuccess: (po) => {
      void qc.invalidateQueries({ queryKey: ['inventory', 'purchase-orders'] });
      toast.ok(`Orden ${po.number} creada en borrador`);
      onClose();
      router.push(`/bodega/recepciones/${po.id}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Nueva orden de compra"
      size="xl"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creando…' : 'Crear borrador'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="po-supplier" className="label">
              Proveedor
            </label>
            <select id="po-supplier" className="input" required value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">{suppliers.isPending ? 'Cargando…' : 'Elige un proveedor'}</option>
              {suppliers.data
                ?.filter((s) => s.active)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </div>
          <WarehouseSelect value={warehouseId} onChange={setWarehouseId} label="Bodega de destino" />
          <div>
            <label htmlFor="po-number" className="label">
              Número (opcional)
            </label>
            <input id="po-number" className="input" maxLength={40} value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Se genera si lo dejas vacío" />
          </div>
          <div>
            <label htmlFor="po-expected" className="label">
              Fecha esperada (opcional)
            </label>
            <input id="po-expected" type="date" className="input" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />
          </div>
        </div>

        <div>
          <p className="mb-1 text-sm font-medium">Agregar prendas</p>
          <VariantPicker onSelect={addVariant} />
        </div>

        {lines.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Variante</th>
                  <th className="num">Cantidad</th>
                  <th className="num">Costo unitario</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.variant.variantId}>
                    <td>
                      <span className="block font-medium">{variantLabel(l.variant)}</span>
                      <span className="font-mono text-xs text-ink-soft">{l.variant.sku}</span>
                    </td>
                    <td className="num">
                      <input
                        aria-label={`Cantidad de ${l.variant.sku}`}
                        className="input w-24 text-right"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={100000}
                        value={l.qty}
                        onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                      />
                    </td>
                    <td className="num">
                      <input
                        aria-label={`Costo unitario de ${l.variant.sku}`}
                        className={`input w-28 text-right ${l.cost && parsed[i].cost === null ? 'border-danger' : ''}`}
                        inputMode="decimal"
                        placeholder="0.00"
                        value={l.cost}
                        onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))}
                      />
                    </td>
                    <td className="text-right">
                      <button className="btn-ghost btn-sm" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Quitar ${l.variant.sku}`}>
                        Quitar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-right text-sm">
              Total estimado: <strong>{formatMoney(total)}</strong>
            </p>
          </div>
        )}
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
