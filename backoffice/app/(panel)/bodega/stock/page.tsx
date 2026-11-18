'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { MovementsTable } from '@/components/bodega/MovementsTable';
import { useWarehouseName, VariantName, WarehouseSelect } from '@/components/bodega/shared';
import { SimplePager } from '@/components/pedidos/SimplePager';
import { VariantPicker } from '@/components/scanner/VariantPicker';
import { useResolveVariants } from '@/components/scanner/variant-cache';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, QueryState } from '@/components/ui/States';
import { api } from '@/lib/api/client';
import { formatInt, formatRelative } from '@/lib/format';
import { type StockLevel, stockTone } from '@/lib/inventory';
import { variantLabel, type VariantLookupItem } from '@/lib/scanner';

const LIMIT = 50;

function StockTable({ rows, showVariant, showWarehouse }: { rows: StockLevel[]; showVariant: boolean; showWarehouse: boolean }) {
  const warehouseName = useWarehouseName();
  useResolveVariants(showVariant ? rows.map((l) => l.variantId) : []);
  return (
    <div className="card overflow-x-auto">
      <table className="table-base">
        <thead>
          <tr>
            {showVariant && <th>Variante</th>}
            {showWarehouse && <th>Bodega</th>}
            <th className="num">Físico</th>
            <th className="num">Reservado</th>
            <th className="num">Disponible</th>
            <th className="num">Reorden</th>
            <th>Ubicación</th>
            <th>Estado</th>
            <th>Actualizado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => {
            const [label, tone] = stockTone(l);
            return (
              <tr key={`${l.variantId}:${l.warehouseId}`}>
                {showVariant && (
                  <td className="max-w-64">
                    <VariantName variantId={l.variantId} />
                  </td>
                )}
                {showWarehouse && <td className="whitespace-nowrap">{warehouseName(l.warehouseId)}</td>}
                <td className="num">{formatInt(l.onHand)}</td>
                <td className="num">{formatInt(l.reserved)}</td>
                <td className="num font-semibold">{formatInt(l.available)}</td>
                <td className="num text-ink-soft">{formatInt(l.reorderPoint)}</td>
                <td className="font-mono text-xs">{l.binLocation ?? '—'}</td>
                <td>
                  <Badge tone={tone}>{label}</Badge>
                </td>
                <td className="whitespace-nowrap text-xs text-ink-soft">{formatRelative(l.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Stock por bodega (GET /inventory/stock): físico, reservado y disponible, con filtro de stock bajo
 * (disponible ≤ punto de reorden). Escanear una prenda muestra su stock en TODAS las bodegas.
 */
export default function StockPage() {
  const [warehouseId, setWarehouseId] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [variant, setVariant] = useState<VariantLookupItem | null>(null);

  const byWarehouse = useQuery({
    queryKey: ['inventory', 'stock', 'warehouse', { warehouseId, lowOnly, offset }],
    queryFn: ({ signal }) =>
      api<StockLevel[]>('/inventory/stock', {
        query: { warehouseId, belowReorderPoint: lowOnly || undefined, limit: LIMIT, offset },
        signal,
      }),
    enabled: Boolean(warehouseId) && !variant,
  });

  const byVariant = useQuery({
    queryKey: ['inventory', 'stock', 'variant', variant?.variantId],
    queryFn: ({ signal }) => api<StockLevel[]>('/inventory/stock', { query: { variantId: variant!.variantId }, signal }),
    enabled: Boolean(variant),
  });

  return (
    <div>
      <PageHeader title="Stock por bodega" description="Existencias físicas, reservadas para pedidos y disponibles para vender." />

      <section className="card mb-4 grid gap-4 p-4 md:grid-cols-[minmax(0,16rem)_1fr]">
        <div className="space-y-3">
          <WarehouseSelect
            value={warehouseId}
            onChange={(id) => {
              setWarehouseId(id);
              setOffset(0);
            }}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={lowOnly}
              onChange={(e) => {
                setLowOnly(e.target.checked);
                setOffset(0);
              }}
            />
            Solo stock bajo (alertas de reposición)
          </label>
        </div>
        <VariantPicker onSelect={setVariant} label="Buscar prenda (escanea, SKU o nombre)" />
      </section>

      {variant ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-semibold">{variantLabel(variant)}</p>
              <p className="font-mono text-xs text-ink-soft">
                {variant.sku}
                {variant.barcode ? ` · ${variant.barcode}` : ''}
              </p>
            </div>
            <button className="btn-ghost btn-sm" onClick={() => setVariant(null)}>
              Volver al listado de la bodega
            </button>
          </div>
          <QueryState query={byVariant}>
            {(rows) =>
              rows.length === 0 ? (
                <EmptyState title="Esta prenda no tiene stock registrado en ninguna bodega" />
              ) : (
                <>
                  <StockTable rows={rows} showVariant={false} showWarehouse />
                  <p className="text-sm text-ink-soft">
                    Total disponible: <strong>{formatInt(rows.reduce((s, r) => s + r.available, 0))}</strong> · reservado{' '}
                    {formatInt(rows.reduce((s, r) => s + r.reserved, 0))}
                  </p>
                </>
              )
            }
          </QueryState>
          <h2 className="text-base font-semibold">Movimientos de la prenda</h2>
          <MovementsTable variantId={variant.variantId} />
        </section>
      ) : !warehouseId ? (
        <p className="text-sm text-ink-soft">Elige una bodega.</p>
      ) : (
        <QueryState query={byWarehouse}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState title={lowOnly ? 'No hay prendas con stock bajo en esta bodega' : 'La bodega no tiene stock registrado'} />
            ) : (
              <>
                <StockTable rows={rows} showVariant showWarehouse={false} />
                <SimplePager count={rows.length} limit={LIMIT} offset={offset} onChange={setOffset} />
              </>
            )
          }
        </QueryState>
      )}
    </div>
  );
}
