import type { Tone } from '@/components/ui/Badge';
import { isoDateInStore, toNumber } from './format';

/**
 * Gerencia: tipos de las respuestas de /reports (módulo Reportes) y helpers puros (rangos de fechas,
 * variaciones vs. el período anterior, etiquetas). Contrato: backend/libs/modules/reports.
 *
 * Ojo con las unidades: los porcentajes del API (marginPct, conversionRate, onTimeRate…) llegan de
 * 0 a 100 con 2 decimales; formatPercent espera una razón (0 a 1), por eso se pasan por pctToRatio.
 */

// ───────────────────────────── Reportes ─────────────────────────────

export const REPORT_KINDS = ['sales', 'sales_items', 'delivery', 'funnel'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const TIME_GROUPS = ['day', 'week', 'month'] as const;
export type TimeGroup = (typeof TIME_GROUPS)[number];

/** Dimensiones válidas por reporte (mismo orden que el dominio). */
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

/** Ruta del endpoint de cada reporte. */
export const REPORT_PATH: Record<ReportKind, string> = {
  sales: '/reports/sales',
  sales_items: '/reports/sales/items',
  delivery: '/reports/delivery',
  funnel: '/reports/funnel',
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

export interface SalesMetrics {
  orders: number;
  units: number;
  grossSales: string;
  netSales: string;
  returns: string;
  cost: string;
  margin: string;
  /** 0 a 100; null sin base. */
  marginPct: number | null;
  averageTicket: string | null;
}

export interface SalesItemsMetrics {
  units: number;
  unitsReturned: number;
  netSales: string;
  returns: string;
  cost: string;
  margin: string;
  marginPct: number | null;
}

export interface DeliveryMetrics {
  shipments: number;
  delivered: number;
  failed: number;
  cancelled: number;
  deliveryRate: number | null;
  avgLeadMinutes: number | null;
  avgTransitMinutes: number | null;
  onTimeRate: number | null;
  within2h: number;
  within24h: number;
  within48h: number;
  over48h: number;
  ratingAvg: number | null;
}

export interface FunnelMetrics {
  cartsCreated: number;
  cartsWithItems: number;
  cartsAbandoned: number;
  abandonmentRate: number | null;
  abandonedValue: string;
  cartsReminded: number;
  ordersPlaced: number;
  ordersPaid: number;
  conversionRate: number | null;
  revenue: string;
}

export interface MetricsByKind {
  sales: SalesMetrics;
  sales_items: SalesItemsMetrics;
  delivery: DeliveryMetrics;
  funnel: FunnelMetrics;
}

export type ReportRow<M> = M & { key: string; label: string };

/** GET /reports/sales | sales/items | delivery | funnel */
export interface ReportResult<M> {
  report: ReportKind;
  groupBy: string;
  from: string;
  to: string;
  /** Último refresco de las vistas (cada 15 min). */
  dataAsOf: string | null;
  rows: ReportRow<M>[];
  totals: M;
}

export interface KpiBlock<M> {
  current: M;
  previous: M;
}

/** GET /reports/kpis (exige los tres permisos de lectura). */
export interface KpiResult {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  dataAsOf: string | null;
  sales: KpiBlock<SalesMetrics>;
  funnel: KpiBlock<FunnelMetrics>;
  delivery: KpiBlock<DeliveryMetrics>;
}

// ───────────────────────────── Rangos de fechas ─────────────────────────────

export interface DateRange {
  /** AAAA-MM-DD (incluido), calendario de Guayaquil. */
  from: string;
  /** AAAA-MM-DD (incluido). */
  to: string;
}

export const RANGE_PRESETS = [
  { id: 'today', label: 'Hoy' },
  { id: '7d', label: '7 días' },
  { id: '30d', label: '30 días' },
  { id: 'month', label: 'Mes actual' },
  { id: 'custom', label: 'Personalizado' },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]['id'];

/** Tope del API: 2 años (731 días). */
export const MAX_RANGE_DAYS = 731;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const ms = dateMs(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** Suma días a una fecha calendario (sin zonas horarias de por medio). */
export function addDays(date: string, days: number): string {
  return new Date(dateMs(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Días del rango, ambos extremos incluidos. */
export function rangeDays(r: DateRange): number {
  return Math.round((dateMs(r.to) - dateMs(r.from)) / 86_400_000) + 1;
}

/** Rango de un atajo, con "hoy" en la hora de Ecuador. */
export function presetRange(preset: Exclude<RangePreset, 'custom'>, now = new Date()): DateRange {
  const today = isoDateInStore(now);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

/** Mismas reglas que el API: fechas válidas, from ≤ to y como máximo 2 años. null si está bien. */
export function rangeError(r: DateRange): string | null {
  if (!isIsoDate(r.from) || !isIsoDate(r.to)) return 'Elige ambas fechas';
  const days = rangeDays(r);
  if (days < 1) return 'La fecha inicial no puede ser posterior a la final';
  if (days > MAX_RANGE_DAYS) return `El rango no puede superar ${MAX_RANGE_DAYS} días`;
  return null;
}

/** Período anterior del mismo largo (el mismo que usa /reports/kpis). */
export function previousRange(r: DateRange): DateRange {
  const days = rangeDays(r);
  return { from: addDays(r.from, -days), to: addDays(r.from, -1) };
}

/** Granularidad del gráfico por tiempo: días hasta 2 meses, semanas hasta 1 año, luego meses. */
export function timeGroupFor(r: DateRange): TimeGroup {
  const days = rangeDays(r);
  if (days <= 62) return 'day';
  if (days <= 366) return 'week';
  return 'month';
}

const shortDay = new Intl.DateTimeFormat('es-EC', { timeZone: 'UTC', day: '2-digit', month: 'short' });
const monthYear = new Intl.DateTimeFormat('es-EC', { timeZone: 'UTC', month: 'short', year: 'numeric' });

/**
 * Etiqueta corta de un período del API: día "2026-10-07" → "07 oct", semana (su lunes) → "sem. 05 oct",
 * mes "2026-10" → "oct 2026". Las claves ya son fechas calendario: se formatean en UTC para no correrlas.
 */
export function periodLabel(key: string, group: string): string {
  if (/^\d{4}-\d{2}$/.test(key)) return monthYear.format(new Date(`${key}-01T00:00:00Z`)).replace('.', '');
  if (!isIsoDate(key)) return key;
  const day = shortDay.format(new Date(`${key}T00:00:00Z`)).replace('.', '');
  return group === 'week' ? `sem. ${day}` : day;
}

/**
 * ¿El período sigue abierto (hoy, esta semana o este mes, hora de Ecuador)? Sus ventas son parciales:
 * el gráfico lo dibuja punteado para que la caída del último punto no parezca un desplome.
 */
export function isOpenPeriod(key: string, group: string, now = new Date()): boolean {
  const today = isoDateInStore(now);
  if (/^\d{4}-\d{2}$/.test(key)) return key === today.slice(0, 7);
  if (!isIsoDate(key)) return false;
  if (group === 'week') return key <= today && today <= addDays(key, 6);
  return key === today;
}

// ───────────────────────────── KPIs ─────────────────────────────

/** 12.5 (porcentaje del API) → 0.125 (para formatPercent). */
export function pctToRatio(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : value / 100;
}

export interface Delta {
  /** Variación relativa (0.1 = +10 %) o diferencia en puntos si kind = 'points'. */
  value: number;
  kind: 'relative' | 'points';
}

/**
 * Variación vs. el período anterior. Para montos y conteos es relativa; para tasas (que ya son %)
 * es en puntos porcentuales. null si no hay con qué comparar (anterior en cero o sin dato).
 */
export function delta(current: string | number | null, previous: string | number | null, kind: Delta['kind'] = 'relative'): Delta | null {
  const c = toNumber(current);
  const p = toNumber(previous);
  if (c === null || p === null) return null;
  if (kind === 'points') return { value: Math.round((c - p) * 100) / 100, kind };
  if (p === 0) return null;
  return { value: (c - p) / Math.abs(p), kind };
}

/** Color de la variación: verde si va en la dirección buena, rojo si en la mala, neutro si no cambia. */
export function deltaTone(d: Delta | null, upIsGood = true): Tone {
  if (!d || Math.abs(d.value) < 1e-9) return 'neutral';
  return d.value > 0 === upIsGood ? 'ok' : 'danger';
}

const signedPct = new Intl.NumberFormat('es-EC', { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' });
const signedNum = new Intl.NumberFormat('es-EC', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });

/** "+12,5 %" o "−1,2 pp". */
export function formatDelta(d: Delta | null): string {
  if (!d) return 'sin comparación';
  return d.kind === 'points' ? `${signedNum.format(d.value)} pp` : signedPct.format(d.value);
}

/** 135 → "2 h 15 min"; 45 → "45 min"; 3000 → "2 d 2 h". */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.round((m % 1440) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** Etapas del embudo (carrito con productos → pedido → venta) con la tasa vs. la etapa anterior. */
export function funnelStages(f: FunnelMetrics): { key: string; label: string; value: number; stepRate: number | null }[] {
  const stages = [
    { key: 'cartsCreated', label: 'Carritos creados', value: f.cartsCreated },
    { key: 'cartsWithItems', label: 'Con productos', value: f.cartsWithItems },
    { key: 'ordersPlaced', label: 'Pedidos creados', value: f.ordersPlaced },
    { key: 'ordersPaid', label: 'Ventas', value: f.ordersPaid },
  ];
  return stages.map((s, i) => {
    const prev = i > 0 ? stages[i - 1].value : null;
    return { ...s, stepRate: prev ? s.value / prev : null };
  });
}

/** Tramos de tiempo de entrega (ordinales, de más rápido a más lento). */
export function deliveryBuckets(d: DeliveryMetrics): { key: string; label: string; value: number; share: number }[] {
  const buckets = [
    { key: 'within2h', label: 'Hasta 2 h', value: d.within2h },
    { key: 'within24h', label: '2 a 24 h', value: d.within24h },
    { key: 'within48h', label: '24 a 48 h', value: d.within48h },
    { key: 'over48h', label: 'Más de 48 h', value: d.over48h },
  ];
  const total = buckets.reduce((s, b) => s + b.value, 0);
  return buckets.map((b) => ({ ...b, share: total ? b.value / total : 0 }));
}

// ───────────────────────────── Exportes ─────────────────────────────

export const EXPORT_FORMATS = ['xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type ExportStatus = 'queued' | 'running' | 'done' | 'failed';

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = { xlsx: 'Excel', pdf: 'PDF' };

export const EXPORT_STATUS: Record<ExportStatus, [string, Tone]> = {
  queued: ['Pendiente', 'neutral'],
  running: ['Procesando', 'info'],
  done: ['Listo', 'ok'],
  failed: ['Falló', 'danger'],
};

/** GET /reports/exports (ExportView). */
export interface ExportJob {
  id: string;
  report: ReportKind;
  format: ExportFormat;
  status: ExportStatus;
  params: DateRange & { groupBy: string; limit: number };
  filename: string | null;
  sizeBytes: number | null;
  rowCount: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
}

export interface CreateExportInput extends DateRange {
  report: ReportKind;
  format: ExportFormat;
  groupBy: string;
}

/** Hay alguno en cola o generándose: el listado se refresca solo mientras tanto. */
export function hasActiveExports(jobs: readonly Pick<ExportJob, 'status'>[] | undefined): boolean {
  return Boolean(jobs?.some((j) => j.status === 'queued' || j.status === 'running'));
}

/** Se puede descargar: listo y sin vencer. */
export function canDownload(job: Pick<ExportJob, 'status' | 'expiresAt'>, now = new Date()): boolean {
  if (job.status !== 'done') return false;
  return !job.expiresAt || new Date(job.expiresAt).getTime() > now.getTime();
}

/** Nombre de respaldo si el API no manda Content-Disposition. */
export function exportFilename(job: Pick<ExportJob, 'report' | 'format' | 'params' | 'filename'>): string {
  if (job.filename) return job.filename;
  return `reporte-${job.report.replace(/_/g, '-')}-${job.params.from}-a-${job.params.to}.${job.format}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Reportes que el usuario puede exportar (reports.export + lectura del reporte). */
export function exportableReports(can: (perm: string) => boolean): ReportKind[] {
  if (!can('reports.export')) return [];
  return REPORT_KINDS.filter((k) => can(REPORT_PERMISSION[k]));
}

// ───────────────────────────── Paleta de gráficos ─────────────────────────────

/**
 * Colores de los gráficos, derivados de los tokens del backoffice y validados con el validador de
 * la guía de visualización (contraste ≥ 3:1 sobre el panel, separación para daltonismo):
 * - serie única: el acento terracota; segunda serie (si hace falta comparar): azul.
 * - escala ordinal (etapas del embudo, tramos de entrega): un solo tono terracota, de claro a oscuro.
 * Los colores de estado (ok, warn, danger) se reservan para estados, nunca para series.
 */
export const CHART = {
  series1: '#b4532a',
  series2: '#2a6db5',
  ordinal: ['#e3a587', '#c9764d', '#b4532a', '#7d3417'],
  grid: '#e6dfd5',
  axis: '#5b5248',
  ink: '#1f1b16',
  surface: '#ffffff',
} as const;
