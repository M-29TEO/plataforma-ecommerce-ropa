'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useWarehouseName, WarehouseSelect } from '@/components/bodega/shared';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { EmptyState, QueryState } from '@/components/ui/States';
import { api } from '@/lib/api/client';
import { formatInt, formatRelative, formatTime, formatDate } from '@/lib/format';
import { FULFILLMENT_LABEL, PAYMENT_METHOD_LABEL } from '@/lib/orders';
import { PICK_STATE_LABEL, type PickingQueueEntry, type PickState } from '@/lib/picking';
import type { Page } from '@/lib/types';

const LIMIT = 50;

/** Cola de picking (GET /fulfillment/picking): pestañas por etapa, filtro de bodega y refresco cada 30 s. */
export default function PickingQueuePage() {
  const [state, setState] = useState<PickState>('to_pick');
  const [warehouseId, setWarehouseId] = useState('');
  const [offset, setOffset] = useState(0);
  const warehouseName = useWarehouseName();

  const q = useQuery({
    queryKey: ['fulfillment', 'picking', { state, warehouseId, offset }],
    queryFn: ({ signal }) =>
      api<Page<PickingQueueEntry>>('/fulfillment/picking', { query: { state, warehouseId: warehouseId || undefined, limit: LIMIT, offset }, signal }),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <PageHeader title="Picking" description="Prepara los pedidos escaneando cada prenda. La lista se actualiza cada 30 s." />

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div role="tablist" aria-label="Etapa" className="inline-flex rounded-md border border-line bg-panel p-0.5">
          {(Object.keys(PICK_STATE_LABEL) as PickState[]).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={state === s}
              className={`rounded px-4 py-2 text-sm font-medium ${state === s ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'}`}
              onClick={() => {
                setState(s);
                setOffset(0);
              }}
            >
              {PICK_STATE_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="w-full sm:w-72">
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
      </div>

      <QueryState query={q}>
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title={state === 'to_pick' ? 'No hay pedidos por preparar' : 'No hay pedidos en preparación'} />
          ) : (
            <>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {page.items.map((o) => (
                  <li key={o.orderId}>
                    <Link href={`/bodega/picking/${o.orderId}`} prefetch={false} className="card block p-4 transition-colors hover:border-ink">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-lg font-semibold">#{o.orderNumber ?? o.orderId.slice(0, 8)}</p>
                          <p className="text-sm text-ink-soft">{o.customerName}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-semibold tabular-nums">{formatInt(o.unitCount)}</p>
                          <p className="text-xs text-ink-soft">unid. · {formatInt(o.itemCount)} líneas</p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <Badge tone="info">{FULFILLMENT_LABEL[o.fulfillmentType] ?? o.fulfillmentType}</Badge>
                        {o.paymentMethod === 'cod' && <Badge tone="warn">{PAYMENT_METHOD_LABEL.cod}</Badge>}
                        {o.deliverySlot && (
                          <Badge tone="accent">
                            Franja {formatDate(o.deliverySlot.startsAt)} {formatTime(o.deliverySlot.startsAt)}–{formatTime(o.deliverySlot.endsAt)}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-2 text-xs text-ink-soft">
                        {warehouseName(o.warehouseId)} · pedido {formatRelative(o.placedAt)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
              <Pagination total={page.total} limit={LIMIT} offset={offset} onChange={setOffset} />
            </>
          )
        }
      </QueryState>
    </div>
  );
}
