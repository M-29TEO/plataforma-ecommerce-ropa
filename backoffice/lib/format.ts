import { STORE_TIME_ZONE } from './config';

/**
 * Formatos para mostrar. El API devuelve dinero como string decimal ("12.50", numeric(12,2)) o
 * número; las fechas en ISO UTC. Se muestran en USD y en la hora de Ecuador.
 */

const money = new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const integer = new Intl.NumberFormat('es-EC', { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('es-EC', { style: 'percent', maximumFractionDigits: 1 });
const dateTime = new Intl.DateTimeFormat('es-EC', { timeZone: STORE_TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('es-EC', { timeZone: STORE_TIME_ZONE, dateStyle: 'medium' });
const timeOnly = new Intl.DateTimeFormat('es-EC', { timeZone: STORE_TIME_ZONE, hour: '2-digit', minute: '2-digit' });

export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatMoney(value: string | number | null | undefined): string {
  const n = toNumber(value);
  return n === null ? '—' : money.format(n);
}

export function formatInt(value: string | number | null | undefined): string {
  const n = toNumber(value);
  return n === null ? '—' : integer.format(n);
}

/** 0.125 → "12,5 %". */
export function formatPercent(ratio: string | number | null | undefined): string {
  const n = toNumber(ratio);
  return n === null ? '—' : percent.format(n);
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  // "AAAA-MM-DD" (fecha de emisión del SRI, períodos) es un día del calendario, no la medianoche UTC:
  // a mediodía UTC cae el mismo día en Ecuador (si no, se mostraría el día anterior).
  const d = value instanceof Date ? value : new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? dateTime.format(d) : '—';
}

export function formatDate(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? dateOnly.format(d) : '—';
}

export function formatTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? timeOnly.format(d) : '—';
}

/** "hace 5 min" para tiempos recientes (última posición de un motorizado, SLA). */
export function formatRelative(value: string | Date | null | undefined, now = new Date()): string {
  const d = toDate(value);
  if (!d) return '—';
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  const future = s < 0;
  const abs = Math.abs(s);
  const text = abs < 60 ? `${abs} s` : abs < 3600 ? `${Math.round(abs / 60)} min` : abs < 86400 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86400)} d`;
  return future ? `en ${text}` : `hace ${text}`;
}

/** Fecha YYYY-MM-DD en la zona de la tienda (para filtros de reportes y nombres de archivo). */
export function isoDateInStore(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: STORE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Nombre completo con lo que haya. */
export function fullName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(' ') || '—';
}
