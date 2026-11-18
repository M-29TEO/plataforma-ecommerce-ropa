'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { SimplePager } from '@/components/pedidos/SimplePager';
import { StatusBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, QueryState } from '@/components/ui/States';
import { api } from '@/lib/api/client';
import { useDebounced } from '@/lib/hooks';
import { formatDateTime, formatInt, formatMoney } from '@/lib/format';
import {
  CHANNEL_LABEL,
  CHANNELS,
  dateRangeQuery,
  FULFILLMENT_LABEL,
  FULFILLMENT_TYPES,
  ORDER_STATUS,
  ORDER_STATUSES,
  orderNumberLabel,
  PAYMENT_METHOD_LABEL,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  PAYMENT_STATUSES,
  type OrderSummary,
} from '@/lib/orders';

const LIMIT = 25;

interface Filters {
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  fulfillmentType: string;
  channel: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { status: '', paymentStatus: '', paymentMethod: '', fulfillmentType: '', channel: '', from: '', to: '' };

/** Atajo "Activos": los que aún requieren trabajo (ni entregados, ni cancelados, ni devueltos). */
const ACTIVE = 'created,paid,preparing,shipped,in_transit';

function Select({
  id,
  label,
  value,
  onChange,
  options,
  all = 'Todos',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  all?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Listado de pedidos (GET /orders) con filtros y paginación. */
export default function OrdersPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const q = useDebounced(search.trim(), 350);

  const set = (k: keyof Filters) => (v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setOffset(0);
  };

  const range = dateRangeQuery(filters.from, filters.to);
  const query = useQuery({
    queryKey: ['orders', 'list', { ...filters, q, offset }],
    queryFn: ({ signal }) =>
      api<OrderSummary[]>('/orders', {
        query: {
          status: filters.status ? filters.status.split(',') : undefined,
          paymentStatus: filters.paymentStatus,
          paymentMethod: filters.paymentMethod,
          fulfillmentType: filters.fulfillmentType,
          channel: filters.channel,
          q: q || undefined,
          from: range.from,
          to: range.to,
          limit: LIMIT,
          offset,
        },
        signal,
      }),
    placeholderData: keepPreviousData,
  });

  const dirty = JSON.stringify(filters) !== JSON.stringify(EMPTY) || search !== '';

  return (
    <div>
      <PageHeader title="Pedidos" description="Todos los pedidos con su estado, pago e historial." />

      <section className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <label htmlFor="o-q" className="label">
            Buscar
          </label>
          <input
            id="o-q"
            className="input"
            type="search"
            placeholder="Número de pedido o email del cliente"
            maxLength={120}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </div>
        <Select
          id="o-status"
          label="Estado"
          value={filters.status}
          onChange={set('status')}
          options={[[ACTIVE, 'Activos (por atender)'], ...ORDER_STATUSES.map((s): [string, string] => [s, ORDER_STATUS[s][0]])]}
        />
        <Select
          id="o-pay"
          label="Pago"
          value={filters.paymentStatus}
          onChange={set('paymentStatus')}
          options={PAYMENT_STATUSES.map((s) => [s, PAYMENT_STATUS[s][0]])}
        />
        <Select
          id="o-method"
          label="Método de pago"
          value={filters.paymentMethod}
          onChange={set('paymentMethod')}
          options={PAYMENT_METHODS.map((s) => [s, PAYMENT_METHOD_LABEL[s]])}
        />
        <Select
          id="o-ful"
          label="Entrega"
          value={filters.fulfillmentType}
          onChange={set('fulfillmentType')}
          options={FULFILLMENT_TYPES.map((s) => [s, FULFILLMENT_LABEL[s]])}
        />
        <Select id="o-channel" label="Canal" value={filters.channel} onChange={set('channel')} options={CHANNELS.map((s) => [s, CHANNEL_LABEL[s]])} />
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="o-from" className="label">
              Desde
            </label>
            <input id="o-from" type="date" className="input" value={filters.from} max={filters.to || undefined} onChange={(e) => set('from')(e.target.value)} />
          </div>
          <div>
            <label htmlFor="o-to" className="label">
              Hasta
            </label>
            <input id="o-to" type="date" className="input" value={filters.to} min={filters.from || undefined} onChange={(e) => set('to')(e.target.value)} />
          </div>
        </div>
        {dirty && (
          <div className="flex items-end">
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                setFilters(EMPTY);
                setSearch('');
                setOffset(0);
              }}
            >
              Limpiar filtros
            </button>
          </div>
        )}
      </section>

      <QueryState query={query}>
        {(orders) =>
          orders.length === 0 && offset === 0 ? (
            <EmptyState title="No hay pedidos con estos filtros" />
          ) : (
            <>
              <div className={`card overflow-x-auto ${query.isPlaceholderData ? 'opacity-60' : ''}`}>
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Pedido</th>
                      <th>Fecha</th>
                      <th>Cliente</th>
                      <th>Estado</th>
                      <th>Pago</th>
                      <th>Entrega</th>
                      <th>Canal</th>
                      <th className="num">Ítems</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <Link href={`/pedidos/${o.id}`} prefetch={false} className="font-medium whitespace-nowrap text-accent-dark hover:underline">
                            {orderNumberLabel(o)}
                          </Link>
                        </td>
                        <td className="whitespace-nowrap">{formatDateTime(o.placedAt)}</td>
                        <td className="max-w-48">
                          <span className="block truncate">{o.customer?.name || '—'}</span>
                          <span className="block truncate text-xs text-ink-soft">{o.customer?.email}</span>
                        </td>
                        <td>
                          <StatusBadge status={o.status} map={ORDER_STATUS} />
                        </td>
                        <td>
                          <StatusBadge status={o.paymentStatus} map={PAYMENT_STATUS} />
                          <span className="block text-xs text-ink-soft">{PAYMENT_METHOD_LABEL[o.paymentMethod] ?? o.paymentMethod}</span>
                        </td>
                        <td className="whitespace-nowrap">{FULFILLMENT_LABEL[o.fulfillmentType] ?? o.fulfillmentType}</td>
                        <td>{CHANNEL_LABEL[o.channel] ?? o.channel}</td>
                        <td className="num">{formatInt(o.itemCount)}</td>
                        <td className="num font-medium">{formatMoney(o.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <SimplePager count={orders.length} limit={LIMIT} offset={offset} onChange={setOffset} />
            </>
          )
        }
      </QueryState>
    </div>
  );
}
