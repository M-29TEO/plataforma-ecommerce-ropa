import { fromCents, toCents, ValidationError } from '../../../shared-kernel';
import { CommissionScheme, deliveryFeeCents, volumeBonusCents } from './commission';
import { addDays, localDate, localInstant } from './slot';
import { weekContaining } from './settlement';

/**
 * Ganancias del motorizado en un rango de días locales (America/Guayaquil), calculadas en vivo con
 * su esquema de comisión (lo mismo que hará la liquidación semanal; aquí es solo una estimación:
 * la liquidación aprobada es la que vale).
 */
export const EARNINGS_MAX_DAYS = 62;
export const EARNINGS_MAX_ITEMS = 100;

export interface EarningsPeriod {
  from: string;
  to: string;
  /** Instantes UTC: [startAt, endAt). */
  startAt: Date;
  endAt: Date;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(name: string, value: string): string {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new ValidationError('INVALID_EARNINGS_PERIOD', `${name} debe ser una fecha AAAA-MM-DD`, { [name]: value });
  }
  return value;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** Por defecto: del lunes de la semana actual a hoy. Máximo EARNINGS_MAX_DAYS días (inclusive). */
export function earningsPeriod(from: string | undefined, to: string | undefined, now: Date): EarningsPeriod {
  const today = localDate(now);
  const f = from ? validDate('from', from) : weekContaining(today).start;
  const t = to ? validDate('to', to) : today;
  if (f > t) throw new ValidationError('INVALID_EARNINGS_PERIOD', 'from no puede ser posterior a to', { from: f, to: t });
  if (daysBetween(f, t) + 1 > EARNINGS_MAX_DAYS) {
    throw new ValidationError('EARNINGS_RANGE_TOO_LONG', `El rango máximo es de ${EARNINGS_MAX_DAYS} días`, { from: f, to: t, maxDays: EARNINGS_MAX_DAYS });
  }
  return { from: f, to: t, startAt: localInstant(f, '00:00'), endAt: localInstant(addDays(t, 1), '00:00') };
}

export interface EarningsDelivery {
  shipmentId: string;
  orderId: string;
  deliveredAt: Date;
  distanceM: number | null;
  codAmount: string;
  codCollected: string | null;
  codMethod: string | null;
}

export interface EarningsSummary {
  period: { from: string; to: string };
  deliveries: number;
  fees: string;
  bonusEstimate: string;
  codCollected: { total: string; cash: string; card_pos: string; deuna_qr: string };
  today: { deliveries: number; fees: string };
  byDay: Array<{ date: string; deliveries: number; fees: string; codCollected: string }>;
  items: Array<{ shipmentId: string; orderId: string; deliveredAt: string; distanceM: number | null; fee: string; codAmount: string; codMethod: string | null }>;
}

/** Totales, desglose por día (todos los días del rango, también los vacíos) e ítems del más nuevo al más viejo. */
export function summarizeEarnings(deliveries: EarningsDelivery[], scheme: CommissionScheme, period: EarningsPeriod, now: Date): EarningsSummary {
  const today = localDate(now);
  const days = new Map<string, { deliveries: number; fees: number; cod: number }>();
  for (let d = period.from; d <= period.to; d = addDays(d, 1)) days.set(d, { deliveries: 0, fees: 0, cod: 0 });

  const cod = { cash: 0, card_pos: 0, deuna_qr: 0 } as Record<'cash' | 'card_pos' | 'deuna_qr', number>;
  let fees = 0;
  let todayCount = 0;
  let todayFees = 0;
  const inRange = deliveries.filter((x) => x.deliveredAt >= period.startAt && x.deliveredAt < period.endAt);
  const items = inRange
    .map((x) => ({ ...x, feeCents: deliveryFeeCents(scheme, x.distanceM) }))
    .sort((a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime() || a.shipmentId.localeCompare(b.shipmentId));

  for (const x of items) {
    const date = localDate(x.deliveredAt);
    const day = days.get(date)!;
    const collected = x.codCollected ? toCents(x.codCollected) : 0;
    day.deliveries += 1;
    day.fees += x.feeCents;
    day.cod += collected;
    fees += x.feeCents;
    if (x.codMethod === 'cash' || x.codMethod === 'card_pos' || x.codMethod === 'deuna_qr') cod[x.codMethod] += collected;
    if (date === today) {
      todayCount += 1;
      todayFees += x.feeCents;
    }
  }

  return {
    period: { from: period.from, to: period.to },
    deliveries: items.length,
    fees: fromCents(fees),
    bonusEstimate: fromCents(volumeBonusCents(scheme, items.length)),
    codCollected: {
      total: fromCents(cod.cash + cod.card_pos + cod.deuna_qr),
      cash: fromCents(cod.cash),
      card_pos: fromCents(cod.card_pos),
      deuna_qr: fromCents(cod.deuna_qr),
    },
    today: { deliveries: todayCount, fees: fromCents(todayFees) },
    byDay: [...days.entries()].map(([date, d]) => ({ date, deliveries: d.deliveries, fees: fromCents(d.fees), codCollected: fromCents(d.cod) })),
    items: items.slice(0, EARNINGS_MAX_ITEMS).map((x) => ({
      shipmentId: x.shipmentId,
      orderId: x.orderId,
      deliveredAt: x.deliveredAt.toISOString(),
      distanceM: x.distanceM,
      fee: fromCents(x.feeCents),
      codAmount: x.codAmount,
      codMethod: x.codMethod,
    })),
  };
}
