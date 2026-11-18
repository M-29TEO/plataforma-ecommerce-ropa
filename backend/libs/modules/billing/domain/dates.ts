/**
 * Fechas del SRI en hora de Ecuador continental (America/Guayaquil, UTC−5 todo el año, sin
 * horario de verano): por eso basta con restar 5 horas.
 */
const OFFSET_MS = 5 * 60 * 60 * 1000;

function shifted(d: Date): string {
  return new Date(d.getTime() - OFFSET_MS).toISOString();
}

/** AAAA-MM-DD del día en Ecuador (columna issue_date). */
export function ecuadorDate(d: Date): string {
  return shifted(d).slice(0, 10);
}

/** AAAA-MM-DD → dd/mm/aaaa (fechaEmision del XML). */
export function sriDate(isoDate: string): string {
  const [y, m, day] = isoDate.split('-');
  return `${day}/${m}/${y}`;
}

/** 2026-09-30T10:15:00-05:00 (SigningTime de XAdES, fechaAutorizacion). */
export function ecuadorDateTime(d: Date): string {
  return `${shifted(d).slice(0, 19)}-05:00`;
}

/** 30/09/2026 10:15:00 (RIDE). */
export function ecuadorDisplayDateTime(d: Date): string {
  const s = shifted(d);
  return `${sriDate(s.slice(0, 10))} ${s.slice(11, 19)}`;
}
