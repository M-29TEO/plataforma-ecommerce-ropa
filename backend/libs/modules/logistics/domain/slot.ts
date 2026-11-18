import { toCents, ValidationError } from '../../../shared-kernel';
import { normalizeTime } from './zone';

/**
 * Ecuador continental no tiene horario de verano: America/Guayaquil es UTC−5 todo el año. Las
 * plantillas se escriben en hora local ("09:00") y las franjas se guardan en UTC (timestamptz).
 */
export const LOCAL_UTC_OFFSET = '-05:00';
const LOCAL_OFFSET_MS = -5 * 60 * 60 * 1000;

/** Plantilla semanal (logistics.delivery_slot_templates). weekday: 0 = domingo … 6 = sábado. */
export interface SlotTemplate {
  id: string;
  zoneId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  capacity: number;
  surcharge: string;
}

export type SlotTemplateProps = Omit<SlotTemplate, 'id' | 'zoneId'>;

/** Franja concreta (logistics.delivery_slots). */
export interface DeliverySlot {
  id: string;
  zoneId: string;
  /** Fecha local 'AAAA-MM-DD'. */
  slotDate: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  booked: number;
  cutoffAt: Date;
  surcharge: string;
}

export type NewDeliverySlot = Omit<DeliverySlot, 'id' | 'booked'>;

export function assertValidTemplate(t: SlotTemplateProps): SlotTemplateProps {
  if (!Number.isInteger(t.weekday) || t.weekday < 0 || t.weekday > 6) {
    throw new ValidationError('INVALID_SLOT_TEMPLATE', 'weekday debe estar entre 0 (domingo) y 6 (sábado)');
  }
  const startTime = normalizeTime(t.startTime, 'startTime');
  const endTime = normalizeTime(t.endTime, 'endTime');
  if (endTime <= startTime) {
    throw new ValidationError('INVALID_SLOT_TEMPLATE', 'La franja debe terminar después de empezar', { startTime, endTime });
  }
  if (!Number.isInteger(t.capacity) || t.capacity < 0 || t.capacity > 10_000) {
    throw new ValidationError('INVALID_SLOT_TEMPLATE', 'La capacidad debe ser un entero entre 0 y 10000');
  }
  toCents(t.surcharge);
  return { ...t, startTime, endTime };
}

/** Fecha local (America/Guayaquil) de un instante: 'AAAA-MM-DD'. */
export function localDate(instant: Date): string {
  return new Date(instant.getTime() + LOCAL_OFFSET_MS).toISOString().slice(0, 10);
}

/** Instante UTC de una fecha y hora locales. */
export function localInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00${LOCAL_UTC_OFFSET}`);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = domingo … 6 = sábado (igual que EXTRACT(dow) de PostgreSQL y Date.getDay()). */
export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export interface SlotGenerationOptions {
  now: Date;
  /** Días hacia adelante, contando hoy. */
  days: number;
  /** La franja cierra esta cantidad de minutos antes de empezar. */
  leadMinutes: number;
  /** Corte del mismo día de la zona ('HH:MM'): una franja de hoy no se toma después de esa hora. */
  sameDayCutoff: string | null;
}

/**
 * Franjas de los próximos `days` días a partir de las plantillas. El cierre (cutoff_at) es el
 * menor entre "inicio − anticipación" y el corte del mismo día de la zona en esa fecha. Las que
 * ya cerraron no se generan. El INSERT usa ON CONFLICT (zone_id, starts_at) DO NOTHING, así que
 * generar dos veces no duplica ni pisa el cupo ya reservado.
 */
export function generateSlots(zoneId: string, templates: SlotTemplateProps[], opts: SlotGenerationOptions): NewDeliverySlot[] {
  const today = localDate(opts.now);
  const slots: NewDeliverySlot[] = [];
  for (let d = 0; d < opts.days; d++) {
    const date = addDays(today, d);
    const weekday = weekdayOf(date);
    for (const t of templates) {
      if (t.weekday !== weekday || t.capacity === 0) continue;
      const startsAt = localInstant(date, t.startTime);
      const byLead = startsAt.getTime() - opts.leadMinutes * 60_000;
      const bySameDay = opts.sameDayCutoff ? localInstant(date, opts.sameDayCutoff).getTime() : Infinity;
      const cutoffAt = new Date(Math.min(byLead, bySameDay));
      if (cutoffAt <= opts.now) continue;
      slots.push({
        zoneId,
        slotDate: date,
        startsAt,
        endsAt: localInstant(date, t.endTime),
        capacity: t.capacity,
        cutoffAt,
        surcharge: t.surcharge,
      });
    }
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Se puede reservar: queda cupo y no pasó el cierre. */
export function isBookable(slot: Pick<DeliverySlot, 'booked' | 'capacity' | 'cutoffAt'>, now: Date): boolean {
  return slot.booked < slot.capacity && slot.cutoffAt > now;
}
