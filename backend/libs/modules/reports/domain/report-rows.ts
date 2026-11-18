import { addDays, DateRange, percent, rangeDays, ReportKind } from './report';

/**
 * Filas de los reportes tal como las devuelve la API y como se exportan. Los agregados vienen de
 * las vistas materializadas (montos como string con 2 decimales, conteos enteros); las tasas y
 * promedios se derivan aquí de las sumas, así un total o una semana se calculan igual que un día.
 */
export type RawAggregate = Record<string, string | number | null>;

export type ColumnType = 'text' | 'int' | 'money' | 'percent' | 'minutes' | 'decimal';

export interface ReportColumn {
  field: string;
  header: string;
  type: ColumnType;
}

export interface ReportRow {
  key: string;
  label: string;
  [metric: string]: string | number | null;
}

export type ReportMetrics = Record<string, string | number | null>;

const int = (raw: RawAggregate, f: string) => Number(raw[f] ?? 0);
const money = (raw: RawAggregate, f: string) => (raw[f] === null || raw[f] === undefined ? '0.00' : String(raw[f]));

/** Columnas de métricas de cada reporte (las mismas para la API, Excel y PDF). */
export const METRIC_COLUMNS: Record<ReportKind, ReportColumn[]> = {
  sales: [
    { field: 'orders', header: 'Pedidos', type: 'int' },
    { field: 'units', header: 'Unidades', type: 'int' },
    { field: 'grossSales', header: 'Ventas brutas', type: 'money' },
    { field: 'netSales', header: 'Ventas netas', type: 'money' },
    { field: 'returns', header: 'Devoluciones', type: 'money' },
    { field: 'cost', header: 'Costo', type: 'money' },
    { field: 'margin', header: 'Margen', type: 'money' },
    { field: 'marginPct', header: 'Margen %', type: 'percent' },
    { field: 'averageTicket', header: 'Ticket promedio', type: 'money' },
  ],
  sales_items: [
    { field: 'units', header: 'Unidades', type: 'int' },
    { field: 'unitsReturned', header: 'Unid. devueltas', type: 'int' },
    { field: 'netSales', header: 'Ventas netas', type: 'money' },
    { field: 'returns', header: 'Devoluciones', type: 'money' },
    { field: 'cost', header: 'Costo', type: 'money' },
    { field: 'margin', header: 'Margen', type: 'money' },
    { field: 'marginPct', header: 'Margen %', type: 'percent' },
  ],
  delivery: [
    { field: 'shipments', header: 'Envíos', type: 'int' },
    { field: 'delivered', header: 'Entregados', type: 'int' },
    { field: 'failed', header: 'Fallidos', type: 'int' },
    { field: 'deliveryRate', header: 'Entrega %', type: 'percent' },
    { field: 'avgLeadMinutes', header: 'Pago a entrega (min)', type: 'minutes' },
    { field: 'avgTransitMinutes', header: 'En ruta (min)', type: 'minutes' },
    { field: 'onTimeRate', header: 'A tiempo %', type: 'percent' },
    { field: 'within2h', header: 'Hasta 2 h', type: 'int' },
    { field: 'within24h', header: '2 a 24 h', type: 'int' },
    { field: 'within48h', header: '24 a 48 h', type: 'int' },
    { field: 'over48h', header: 'Más de 48 h', type: 'int' },
    { field: 'ratingAvg', header: 'Calificación', type: 'decimal' },
  ],
  funnel: [
    { field: 'cartsCreated', header: 'Carritos', type: 'int' },
    { field: 'cartsWithItems', header: 'Con productos', type: 'int' },
    { field: 'cartsAbandoned', header: 'Abandonados', type: 'int' },
    { field: 'abandonmentRate', header: 'Abandono %', type: 'percent' },
    { field: 'abandonedValue', header: 'Valor abandonado', type: 'money' },
    { field: 'cartsReminded', header: 'Recordados', type: 'int' },
    { field: 'ordersPlaced', header: 'Pedidos', type: 'int' },
    { field: 'ordersPaid', header: 'Ventas', type: 'int' },
    { field: 'conversionRate', header: 'Conversión %', type: 'percent' },
    { field: 'revenue', header: 'Ingresos', type: 'money' },
  ],
};

/** Agregados en cero (días o semanas sin datos en un reporte por tiempo). */
export const ZERO_AGGREGATE: Record<ReportKind, RawAggregate> = {
  sales: {
    orders: 0, units: 0, gross_sales: '0.00', net_sales: '0.00', returns: '0.00', cost: '0.00',
    net_sales_costed: '0.00', margin: '0.00', average_ticket: null,
  },
  sales_items: { units: 0, units_returned: 0, net_sales: '0.00', returns: '0.00', cost: '0.00', net_sales_costed: '0.00', margin: '0.00' },
  delivery: {
    shipments: 0, delivered: 0, failed: 0, cancelled: 0, lead_count: 0, avg_lead_minutes: null, avg_transit_minutes: null,
    within_2h: 0, within_24h: 0, within_48h: 0, over_48h: 0, with_promise: 0, on_time: 0, rating_avg: null,
  },
  funnel: {
    carts_created: 0, carts_with_items: 0, carts_abandoned: 0, abandoned_value: '0.00', carts_reminded: 0,
    orders_placed: 0, orders_paid: 0, revenue: '0.00',
  },
};

/** Convierte los agregados de la vista en las métricas del reporte. */
export function toMetrics(kind: ReportKind, raw: RawAggregate): ReportMetrics {
  switch (kind) {
    case 'sales':
      return {
        orders: int(raw, 'orders'),
        units: int(raw, 'units'),
        grossSales: money(raw, 'gross_sales'),
        netSales: money(raw, 'net_sales'),
        returns: money(raw, 'returns'),
        cost: money(raw, 'cost'),
        margin: money(raw, 'margin'),
        marginPct: percent(Number(raw.margin ?? 0), Number(raw.net_sales_costed ?? 0)),
        averageTicket: raw.average_ticket === null || raw.average_ticket === undefined ? null : String(raw.average_ticket),
      };
    case 'sales_items':
      return {
        units: int(raw, 'units'),
        unitsReturned: int(raw, 'units_returned'),
        netSales: money(raw, 'net_sales'),
        returns: money(raw, 'returns'),
        cost: money(raw, 'cost'),
        margin: money(raw, 'margin'),
        marginPct: percent(Number(raw.margin ?? 0), Number(raw.net_sales_costed ?? 0)),
      };
    case 'delivery': {
      const delivered = int(raw, 'delivered');
      return {
        shipments: int(raw, 'shipments'),
        delivered,
        failed: int(raw, 'failed'),
        cancelled: int(raw, 'cancelled'),
        deliveryRate: percent(delivered, int(raw, 'shipments') - int(raw, 'cancelled')),
        avgLeadMinutes: raw.avg_lead_minutes === null ? null : Number(raw.avg_lead_minutes),
        avgTransitMinutes: raw.avg_transit_minutes === null ? null : Number(raw.avg_transit_minutes),
        onTimeRate: percent(int(raw, 'on_time'), int(raw, 'with_promise')),
        within2h: int(raw, 'within_2h'),
        within24h: int(raw, 'within_24h'),
        within48h: int(raw, 'within_48h'),
        over48h: int(raw, 'over_48h'),
        ratingAvg: raw.rating_avg === null ? null : Number(raw.rating_avg),
      };
    }
    case 'funnel': {
      const withItems = int(raw, 'carts_with_items');
      return {
        cartsCreated: int(raw, 'carts_created'),
        cartsWithItems: withItems,
        cartsAbandoned: int(raw, 'carts_abandoned'),
        abandonmentRate: percent(int(raw, 'carts_abandoned'), withItems),
        abandonedValue: money(raw, 'abandoned_value'),
        cartsReminded: int(raw, 'carts_reminded'),
        ordersPlaced: int(raw, 'orders_placed'),
        ordersPaid: int(raw, 'orders_paid'),
        conversionRate: percent(int(raw, 'orders_paid'), withItems),
        revenue: money(raw, 'revenue'),
      };
    }
  }
}

/** Lunes (AAAA-MM-DD) de la semana ISO de la fecha. */
export function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return addDays(date, -((dow + 6) % 7));
}

/**
 * Claves de todos los períodos del rango (día AAAA-MM-DD, semana = su lunes, mes AAAA-MM), para
 * que un gráfico por tiempo no salte los días sin ventas.
 */
export function timeBuckets(range: DateRange, group: 'day' | 'week' | 'month'): string[] {
  const keys: string[] = [];
  const days = rangeDays(range);
  for (let i = 0; i < days; i++) {
    const d = addDays(range.from, i);
    const key = group === 'day' ? d : group === 'week' ? weekStart(d) : d.slice(0, 7);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

export const VALUE_LABELS: Record<string, Record<string, string>> = {
  payment_method: {
    card: 'Tarjeta', deuna: 'DeUna', pichincha: 'Banco Pichincha', transfer: 'Transferencia', qr: 'QR',
    cod: 'Contra entrega', gift_card: 'Gift card',
  },
  fulfillment_type: { rider: 'Motorizado', courier: 'Courier', pickup: 'Retiro en tienda' },
  carrier_type: { rider: 'Motorizado', courier: 'Courier', pickup: 'Retiro en tienda' },
  channel: { web: 'Web', app: 'App', whatsapp: 'WhatsApp', backoffice: 'Backoffice', store: 'Tienda' },
};

export function displayLabel(groupBy: string, label: string): string {
  return VALUE_LABELS[groupBy]?.[label] ?? label;
}
