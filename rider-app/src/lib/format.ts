/**
 * Formatos de la app: dólares y horas de America/Guayaquil. Ecuador continental es UTC−5 todo el
 * año (sin horario de verano), así que se calcula a mano: el Intl de Hermes en Android no siempre
 * respeta la opción timeZone.
 */
const GYE_OFFSET_MS = -5 * 60 * 60 * 1000;
const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const pad = (n: number) => String(n).padStart(2, '0');

/** Fecha "de pared" en Guayaquil (los getters UTC del resultado dan la hora local). */
function gye(iso: string | Date): Date {
  return new Date((typeof iso === 'string' ? new Date(iso) : iso).getTime() + GYE_OFFSET_MS);
}

/** Centavos de un monto "12.50" (o número). Lanza si no es un monto válido con hasta 2 decimales. */
export function toCents(amount: string | number): number {
  const s = typeof amount === 'number' ? amount.toFixed(2) : amount.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Monto inválido: ${amount}`);
  const [int, dec = ''] = s.split('.');
  return Number(int) * 100 + Number(dec.padEnd(2, '0'));
}

export function fromCents(cents: number): string {
  return `${Math.trunc(cents / 100)}.${pad(Math.abs(cents % 100))}`;
}

/** "1234.5" → "$1.234,50" (formato de Ecuador). */
export function formatMoney(amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '';
  let cents: number;
  try {
    cents = toCents(amount);
  } catch {
    return '';
  }
  const int = String(Math.trunc(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `$${int},${pad(cents % 100)}`;
}

export function isPositiveAmount(amount: string | null | undefined): boolean {
  if (!amount) return false;
  try {
    return toCents(amount) > 0;
  } catch {
    return false;
  }
}

export function formatTime(iso: string | Date): string {
  const d = gye(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "lun 6 oct". */
export function formatDay(iso: string | Date): string {
  const d = gye(iso);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Fecha YYYY-MM-DD (del API de ganancias) → "lun 6 oct" sin pasar por zonas horarias. */
export function formatIsoDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[utc.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** Hoy en Guayaquil como YYYY-MM-DD. */
export function todayIso(now = new Date()): string {
  const d = gye(now);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Suma días a una fecha YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
}

/** Lunes de la semana de la fecha (la semana de liquidación va de lunes a domingo). */
export function mondayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

export function formatSlot(slot: { startsAt: string; endsAt: string }): string {
  return `${formatDay(slot.startsAt)} · ${formatTime(slot.startsAt)}–${formatTime(slot.endsAt)}`;
}

export function formatDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return '';
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

/** Duración de un turno: "3 h 05 min". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h} h ${pad(minutes % 60)} min` : `${minutes} min`;
}

/** Segundos que faltan para que venza una oferta (nunca negativo). */
export function secondsLeft(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
}
