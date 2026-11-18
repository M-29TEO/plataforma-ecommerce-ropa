import { addDays, mondayOf, todayIso } from './format';

export type Period = 'today' | 'week' | 'lastWeek';

/** Rango de fechas (Guayaquil) de cada pestaña; la semana va de lunes a domingo como la liquidación. */
export function periodRange(p: Period, today = todayIso()): { from: string; to: string } {
  if (p === 'today') return { from: today, to: today };
  const monday = mondayOf(today);
  if (p === 'week') return { from: monday, to: today };
  return { from: addDays(monday, -7), to: addDays(monday, -1) };
}
