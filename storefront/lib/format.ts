/** Formatos de la tienda: dólares (USD) y fechas en America/Guayaquil, en español de Ecuador. */

export const TIME_ZONE = 'America/Guayaquil';
const LOCALE = 'es-EC';

const money = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

/** "49.90" → "$49,90" (el API manda el dinero como texto con 2 decimales). */
export function formatMoney(amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = typeof amount === 'number' ? amount : Number(amount);
  return Number.isFinite(n) ? money.format(n) : '';
}

/** Porcentaje de descuento redondeado (69.90 → 49.90 = 29 %). null si no hay rebaja. */
export function discountPercent(price: string, compareAt: string | null | undefined): number | null {
  if (!compareAt) return null;
  const p = Number(price);
  const c = Number(compareAt);
  if (!(c > p) || p <= 0) return null;
  return Math.round(((c - p) / c) * 100);
}

export function formatDate(iso: string | Date, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, ...opts }).format(typeof iso === 'string' ? new Date(iso) : iso);
}

export function formatTime(iso: string | Date): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    typeof iso === 'string' ? new Date(iso) : iso,
  );
}

/** Franja de entrega: "lun., 6 oct. · 10:00–12:00". */
export function formatSlot(startsAt: string, endsAt: string): string {
  const day = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(startsAt));
  return `${day} · ${formatTime(startsAt)}–${formatTime(endsAt)}`;
}

/** Minutos restantes legibles: 45 s → "1 min", 3700 s → "1 h 2 min". */
export function formatEta(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
