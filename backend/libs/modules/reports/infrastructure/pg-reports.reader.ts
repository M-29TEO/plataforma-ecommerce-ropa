import { Injectable } from '@nestjs/common';
import { Database } from '../../../shared-kernel';
import { AggregateRow, ReportsReader } from '../application/ports';
import { DateRange, ReportKind, TIME_GROUPS } from '../domain/report';
import { RawAggregate } from '../domain/report-rows';

interface Dimension {
  key: string;
  label: string;
}

const TIME: Record<string, Dimension> = {
  day: { key: `day::text`, label: `day::text` },
  week: { key: `date_trunc('week', day)::date::text`, label: `date_trunc('week', day)::date::text` },
  month: { key: `to_char(day, 'YYYY-MM')`, label: `to_char(day, 'YYYY-MM')` },
};

/**
 * Sin courier externo (courier_key vacío) la vista dice 'Sin courier', que en el dashboard parecía
 * un error: son entregas de la flota propia (en ventas, también los retiros en tienda).
 */
const ownFleet = (label: string): Dimension => ({ key: 'courier_key', label: `CASE WHEN courier_key = '' THEN '${label}' ELSE courier_name END` });
const COURIER_SALES = ownFleet('Flota propia o retiro');
const COURIER_DELIVERY = ownFleet('Flota propia');
const RIDER: Dimension = { key: 'rider_key', label: 'rider_name' };

/**
 * Lista blanca de SQL: el groupBy llega validado por el dominio y aquí solo se elige una de estas
 * expresiones fijas; nada del request se concatena en la consulta (fechas y tenant van como $n).
 */
const SPECS: Record<ReportKind, { view: string; metrics: string; orderBy: string; dimensions: Record<string, Dimension> }> = {
  sales: {
    view: 'reports.mv_sales_daily',
    metrics: `
      COALESCE(sum(orders), 0)::int AS orders,
      COALESCE(sum(units), 0)::int AS units,
      COALESCE(sum(gross_sales), 0)::numeric(14,2)::text AS gross_sales,
      COALESCE(sum(net_sales), 0)::numeric(14,2)::text AS net_sales,
      COALESCE(sum(returns_net), 0)::numeric(14,2)::text AS returns,
      COALESCE(sum(cost), 0)::numeric(14,2)::text AS cost,
      COALESCE(sum(net_sales_costed), 0)::numeric(14,2)::text AS net_sales_costed,
      COALESCE(sum(net_sales_costed) - sum(cost), 0)::numeric(14,2)::text AS margin,
      (sum(gross_sales) / NULLIF(sum(orders), 0))::numeric(14,2)::text AS average_ticket`,
    orderBy: 'sum(net_sales) DESC NULLS LAST',
    dimensions: {
      ...TIME,
      city: { key: 'city', label: 'city' },
      neighborhood: { key: `city || ' | ' || neighborhood`, label: `neighborhood || ' (' || city || ')'` },
      payment_method: { key: 'payment_method', label: 'payment_method' },
      fulfillment_type: { key: 'fulfillment_type', label: 'fulfillment_type' },
      channel: { key: 'channel', label: 'channel' },
      courier: COURIER_SALES,
      rider: RIDER,
    },
  },
  sales_items: {
    view: 'reports.mv_sales_items_daily',
    metrics: `
      COALESCE(sum(units), 0)::int AS units,
      COALESCE(sum(units_returned), 0)::int AS units_returned,
      COALESCE(sum(net_sales), 0)::numeric(14,2)::text AS net_sales,
      COALESCE(sum(returns_net), 0)::numeric(14,2)::text AS returns,
      COALESCE(sum(cost), 0)::numeric(14,2)::text AS cost,
      COALESCE(sum(net_sales_costed), 0)::numeric(14,2)::text AS net_sales_costed,
      COALESCE(sum(net_sales_costed) - sum(cost), 0)::numeric(14,2)::text AS margin`,
    orderBy: 'sum(net_sales) DESC NULLS LAST',
    dimensions: {
      category: { key: 'category', label: 'category' },
      size: { key: 'size', label: 'size' },
      color: { key: 'color', label: 'color' },
      product: { key: 'product_id::text', label: 'max(product_name)' },
    },
  },
  delivery: {
    view: 'reports.mv_delivery_performance',
    metrics: `
      COALESCE(sum(shipments), 0)::int AS shipments,
      COALESCE(sum(delivered), 0)::int AS delivered,
      COALESCE(sum(failed), 0)::int AS failed,
      COALESCE(sum(cancelled), 0)::int AS cancelled,
      COALESCE(sum(lead_count), 0)::int AS lead_count,
      round(sum(lead_min_sum) / NULLIF(sum(lead_count), 0))::int AS avg_lead_minutes,
      round(sum(transit_min_sum) / NULLIF(sum(transit_count), 0))::int AS avg_transit_minutes,
      COALESCE(sum(within_2h), 0)::int AS within_2h,
      COALESCE(sum(within_24h), 0)::int AS within_24h,
      COALESCE(sum(within_48h), 0)::int AS within_48h,
      COALESCE(sum(within_72h) + sum(over_72h), 0)::int AS over_48h,
      COALESCE(sum(with_promise), 0)::int AS with_promise,
      COALESCE(sum(on_time), 0)::int AS on_time,
      round(sum(rating_sum)::numeric / NULLIF(sum(rating_count), 0), 2)::float8 AS rating_avg`,
    orderBy: 'sum(shipments) DESC',
    dimensions: {
      ...TIME,
      carrier_type: { key: 'carrier_type', label: 'carrier_type' },
      courier: COURIER_DELIVERY,
      rider: RIDER,
      zone: { key: 'zone_key', label: 'zone_name' },
    },
  },
  funnel: {
    view: 'reports.mv_funnel_daily',
    metrics: `
      COALESCE(sum(carts_created), 0)::int AS carts_created,
      COALESCE(sum(carts_with_items), 0)::int AS carts_with_items,
      COALESCE(sum(carts_abandoned), 0)::int AS carts_abandoned,
      COALESCE(sum(abandoned_value), 0)::numeric(14,2)::text AS abandoned_value,
      COALESCE(sum(carts_reminded), 0)::int AS carts_reminded,
      COALESCE(sum(orders_placed), 0)::int AS orders_placed,
      COALESCE(sum(orders_paid), 0)::int AS orders_paid,
      COALESCE(sum(revenue), 0)::numeric(14,2)::text AS revenue`,
    orderBy: 'sum(orders_paid) DESC',
    dimensions: { ...TIME },
  },
};

const VIEW_NAMES: Record<ReportKind, string> = {
  sales: 'mv_sales_daily',
  sales_items: 'mv_sales_items_daily',
  delivery: 'mv_delivery_performance',
  funnel: 'mv_funnel_daily',
};

@Injectable()
export class PgReportsReader extends ReportsReader {
  constructor(private readonly db: Database) {
    super();
  }

  async grouped(kind: ReportKind, tenantId: string, range: DateRange, groupBy: string, limit: number): Promise<AggregateRow[]> {
    const spec = SPECS[kind];
    const dim = spec.dimensions[groupBy];
    if (!dim) throw new Error(`Dimensión no soportada: ${kind}.${groupBy}`);
    const isTime = (TIME_GROUPS as readonly string[]).includes(groupBy);
    // label con agregado (producto) no va en el GROUP BY.
    const groupCols = dim.label.startsWith('max(') ? '1' : '1, 2';
    const { rows } = await this.db.query<RawAggregate & { key: string; label: string }>(
      `SELECT ${dim.key} AS key, ${dim.label} AS label, ${spec.metrics}
         FROM ${spec.view}
        WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date
        GROUP BY ${groupCols}
        ORDER BY ${isTime ? '1' : `${spec.orderBy}, 2`}
        ${isTime ? '' : 'LIMIT $4'}`,
      isTime ? [tenantId, range.from, range.to] : [tenantId, range.from, range.to, limit],
    );
    return rows.map(({ key, label, ...raw }) => ({ key, label, raw }));
  }

  async totals(kind: ReportKind, tenantId: string, range: DateRange): Promise<RawAggregate> {
    const spec = SPECS[kind];
    const { rows } = await this.db.query<RawAggregate>(
      `SELECT ${spec.metrics} FROM ${spec.view} WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date`,
      [tenantId, range.from, range.to],
    );
    return rows[0];
  }

  async dataAsOf(kind: ReportKind): Promise<Date | null> {
    const { rows } = await this.db.query<{ refreshed_at: Date }>(`SELECT refreshed_at FROM reports.refresh_log WHERE view_name = $1`, [
      VIEW_NAMES[kind],
    ]);
    return rows[0]?.refreshed_at ?? null;
  }
}

export const MATERIALIZED_VIEWS = Object.values(VIEW_NAMES);
