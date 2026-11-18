'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { CreatePurchaseOrderModal } from '@/components/bodega/CreatePurchaseOrderModal';
import { useSuppliers, useWarehouseName, WarehouseSelect } from '@/components/bodega/shared';
import { SimplePager } from '@/components/pedidos/SimplePager';
import { useCan } from '@/components/providers/AuthProvider';
import { StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, QueryState } from '@/components/ui/States';
import { api } from '@/lib/api/client';
import { formatDate, formatInt, formatMoney } from '@/lib/format';
import { PO_STATUS, poProgress, type PurchaseOrder, type PurchaseOrderStatus } from '@/lib/inventory';

type View = 'to_receive' | 'all' | PurchaseOrderStatus;
const LIMIT = 20;

/**
 * Órdenes de compra. Por defecto "Por recibir" (enviadas + recibidas parcialmente): el API filtra
 * un estado por consulta, así que se piden las dos y se unen.
 */
export default function ReceptionsPage() {
  const can = useCan();
  const [view, setView] = useState<View>('to_receive');
  const [warehouseId, setWarehouseId] = useState('');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const suppliers = useSuppliers();
  const warehouseName = useWarehouseName();

  const q = useQuery({
    queryKey: ['inventory', 'purchase-orders', { view, warehouseId, offset }],
    queryFn: async ({ signal }) => {
      const base = { warehouseId: warehouseId || undefined };
      if (view === 'to_receive') {
        const [sent, partial] = await Promise.all(
          (['sent', 'partially_received'] as const).map((status) =>
            api<PurchaseOrder[]>('/inventory/purchase-orders', { query: { ...base, status, limit: 100 }, signal }),
          ),
        );
        return [...partial, ...sent].sort((a, b) => (a.expectedAt ?? '9999').localeCompare(b.expectedAt ?? '9999') || a.createdAt.localeCompare(b.createdAt));
      }
      return api<PurchaseOrder[]>('/inventory/purchase-orders', {
        query: { ...base, status: view === 'all' ? undefined : view, limit: LIMIT, offset },
        signal,
      });
    },
  });

  const supplierName = (id: string) => suppliers.data?.find((s) => s.id === id)?.name ?? '—';

  return (
    <div>
      <PageHeader
        title="Recepción de compras"
        description="Recibe la mercadería de las órdenes de compra escaneando cada prenda."
        actions={
          can('inventory.purchase.write') && (
            <button className="btn-primary" onClick={() => setCreating(true)}>
              Nueva orden de compra
            </button>
          )
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="po-view" className="label">
            Estado
          </label>
          <select
            id="po-view"
            className="input"
            value={view}
            onChange={(e) => {
              setView(e.target.value as View);
              setOffset(0);
            }}
          >
            <option value="to_receive">Por recibir</option>
            <option value="all">Todas</option>
            {(Object.keys(PO_STATUS) as PurchaseOrderStatus[]).map((s) => (
              <option key={s} value={s}>
                {PO_STATUS[s][0]}
              </option>
            ))}
          </select>
        </div>
        <WarehouseSelect
          value={warehouseId}
          onChange={(id) => {
            setWarehouseId(id);
            setOffset(0);
          }}
          autoSelect={false}
          allowEmpty
        />
      </div>

      <QueryState query={q}>
        {(orders) =>
          orders.length === 0 ? (
            <EmptyState title={view === 'to_receive' ? 'No hay órdenes por recibir' : 'Sin órdenes de compra'}>
              {view === 'to_receive' && 'Las órdenes aparecen aquí cuando se marcan como enviadas al proveedor.'}
            </EmptyState>
          ) : (
            <>
              <div className="card overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Número</th>
                      <th>Proveedor</th>
                      <th>Bodega</th>
                      <th>Estado</th>
                      <th>Esperada</th>
                      <th className="num">Recibido</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((po) => {
                      const p = poProgress(po.items);
                      return (
                        <tr key={po.id}>
                          <td>
                            <Link href={`/bodega/recepciones/${po.id}`} prefetch={false} className="font-medium text-accent-dark hover:underline">
                              {po.number}
                            </Link>
                          </td>
                          <td>{supplierName(po.supplierId)}</td>
                          <td className="whitespace-nowrap">{warehouseName(po.warehouseId)}</td>
                          <td>
                            <StatusBadge status={po.status} map={PO_STATUS} />
                          </td>
                          <td className="whitespace-nowrap">{formatDate(po.expectedAt ? `${po.expectedAt}T12:00:00Z` : null)}</td>
                          <td className="num whitespace-nowrap">
                            {formatInt(p.received)} / {formatInt(p.ordered)}
                          </td>
                          <td className="num">{formatMoney(po.total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {view !== 'to_receive' && <SimplePager count={orders.length} limit={LIMIT} offset={offset} onChange={setOffset} />}
            </>
          )
        }
      </QueryState>

      {creating && <CreatePurchaseOrderModal onClose={() => setCreating(false)} />}
    </div>
  );
}
