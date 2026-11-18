import { ValidationError } from '../../../shared-kernel';

/**
 * Reportes del gerente. Cada reporte lee una vista materializada y se agrupa por una de sus
 * dimensiones; los rangos son de días calendario en America/Guayaquil (from y to incluidos).
 */
export const REPORT_KINDS = ['sales', 'sales_items', 'delivery', 'funnel'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const TIME_GROUPS = ['day', 'week', 'month'] as const;

export const GROUP_BY: Record<ReportKind, readonly string[]> = {
  sales: [...TIME_GROUPS, 'city', 'neighborhood', 'payment_method', 'fulfillment_type', 'channel', 'courier', 'rider'],
  sales_items: ['category', 'size', 'color', 'product'],
  delivery: [...TIME_GROUPS, 'carrier_type', 'courier', 'rider', 'zone'],
  funnel: [...TIME_GROUPS],
};

export const DEFAULT_GROUP_BY: Record<ReportKind, string> = {
  sales: 'day',
  sales_items: 'category',
  delivery: 'courier',
  funnel: 'day',
};

/** Permiso de lectura de cada reporte; exportarlo exige además reports.export. */
export const REPORT_PERMISSION: Record<ReportKind, string> = {
  sales: 'reports.sales.read',
  sales_items: 'reports.sales.read',
  delivery: 'reports.delivery.read',
  funnel: 'reports.funnel.read',
};

export const REPORT_TITLES: Record<ReportKind, string> = {
  sales: 'Ventas',
  sales_items: 'Ventas por producto',
  delivery: 'Tiempos de entrega',
  funnel: 'Conversión y carritos abandonados',
};

export const GROUP_LABELS: Record<string, string> = {
  day: 'Día',
  week: 'Semana',
  month: 'Mes',
  city: 'Ciudad',
  neighborhood: 'Barrio',
  payment_method: 'Método de pago',
  fulfillment_type: 'Tipo de entrega',
  channel: 'Canal',
  courier: 'Courier',
  rider: 'Motorizado',
  category: 'Categoría',
  size: 'Talla',
  color: 'Color',
  product: 'Producto',
  carrier_type: 'Tipo de transporte',
  zone: 'Zona',
};

export const MAX_RANGE_DAYS = 731;
export const DEFAULT_RANGE_DAYS = 30;
const TZ = 'America/Guayaquil';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRange {
  /** AAAA-MM-DD, incluido. */
  from: string;
  /** AAAA-MM-DD, incluido. */
  to: string;
}

export interface ReportQuery extends DateRange {
  groupBy: string;
  /** Tope de filas (solo agrupaciones que no son de tiempo; se ordenan por la métrica principal). */
  limit: number;
}

export class InvalidReportQueryError extends ValidationError {}

/** Fecha calendario de Guayaquil (AAAA-MM-DD) del instante dado. */
export function localDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function parseDate(value: string, field: string): number {
  if (!DATE_RE.test(value)) throw new InvalidReportQueryError('INVALID_DATE', `${field} debe tener el formato AAAA-MM-DD`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new InvalidReportQueryError('INVALID_DATE', `${field} no es una fecha válida`);
  }
  return ms;
}

export function addDays(date: string, days: number): string {
  return new Date(parseDate(date, 'fecha') + days * 86_400_000).toISOString().slice(0, 10);
}

export function rangeDays(r: DateRange): number {
  return Math.round((parseDate(r.to, 'to') - parseDate(r.from, 'from')) / 86_400_000) + 1;
}

/** Sin fechas: los últimos 30 días hasta hoy. Valida el orden y el largo máximo (2 años). */
export function resolveRange(input: { from?: string; to?: string }, now: Date): DateRange {
  const to = input.to ?? localDate(now);
  const from = input.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  const days = rangeDays({ from, to });
  if (days < 1) throw new InvalidReportQueryError('INVALID_RANGE', 'from no puede ser posterior a to');
  if (days > MAX_RANGE_DAYS) throw new InvalidReportQueryError('RANGE_TOO_LONG', `El rango no puede superar ${MAX_RANGE_DAYS} días`);
  return { from, to };
}

/** Período anterior del mismo largo (para comparar los KPIs). */
export function previousRange(r: DateRange): DateRange {
  const days = rangeDays(r);
  return { from: addDays(r.from, -days), to: addDays(r.from, -1) };
}

export function resolveQuery(
  kind: ReportKind,
  input: { from?: string; to?: string; groupBy?: string; limit?: number },
  now: Date,
): ReportQuery {
  const groupBy = input.groupBy ?? DEFAULT_GROUP_BY[kind];
  if (!GROUP_BY[kind].includes(groupBy)) {
    throw new InvalidReportQueryError('INVALID_GROUP_BY', `groupBy debe ser uno de: ${GROUP_BY[kind].join(', ')}`, {
      allowed: GROUP_BY[kind],
    });
  }
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new InvalidReportQueryError('INVALID_LIMIT', 'limit debe estar entre 1 y 1000');
  }
  return { ...resolveRange(input, now), groupBy, limit };
}

/** a / b en porcentaje con 2 decimales; null si no hay base. */
export function percent(a: number, b: number): number | null {
  if (!b) return null;
  return Math.round((a / b) * 10_000) / 100;
}
