import { ValidationError } from '../../../shared-kernel';
import { addDays, assertValidTemplate, generateSlots, isBookable, localDate, localInstant, weekdayOf } from './slot';

const tpl = (weekday: number, startTime: string, endTime: string, capacity = 5, surcharge = '0.00') => ({
  weekday,
  startTime,
  endTime,
  capacity,
  surcharge,
});

describe('fechas en America/Guayaquil (UTC−5)', () => {
  it('la fecha local cambia a las 19:00 UTC', () => {
    expect(localDate(new Date('2026-09-29T04:59:00Z'))).toBe('2026-09-28');
    expect(localDate(new Date('2026-09-29T05:00:00Z'))).toBe('2026-09-29');
  });

  it('hora local → instante UTC, días y día de la semana', () => {
    expect(localInstant('2026-09-29', '09:00').toISOString()).toBe('2026-09-29T14:00:00.000Z');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(weekdayOf('2026-09-29')).toBe(2); // martes
    expect(weekdayOf('2026-10-04')).toBe(0); // domingo
  });
});

describe('assertValidTemplate', () => {
  it('normaliza la hora y valida el orden', () => {
    expect(assertValidTemplate(tpl(1, '09:00:00', '12:00'))).toMatchObject({ startTime: '09:00', endTime: '12:00' });
    expect(() => assertValidTemplate(tpl(1, '12:00', '09:00'))).toThrow(ValidationError);
    expect(() => assertValidTemplate(tpl(7, '09:00', '12:00'))).toThrow(/weekday/);
    expect(() => assertValidTemplate(tpl(1, '9h', '12:00'))).toThrow(/HH:MM/);
    expect(() => assertValidTemplate(tpl(1, '09:00', '12:00', -1))).toThrow(/capacidad/);
  });
});

describe('generateSlots', () => {
  // Martes 29/09/2026 08:00 hora local.
  const now = new Date('2026-09-29T13:00:00Z');
  const opts = { now, days: 7, leadMinutes: 120, sameDayCutoff: null };

  it('una franja por plantilla y día de la semana, ordenadas', () => {
    const slots = generateSlots('z1', [tpl(2, '15:00', '18:00'), tpl(3, '09:00', '12:00')], opts);
    expect(slots.map((s) => [s.slotDate, s.startsAt.toISOString(), s.endsAt.toISOString()])).toEqual([
      ['2026-09-29', '2026-09-29T20:00:00.000Z', '2026-09-29T23:00:00.000Z'],
      ['2026-09-30', '2026-09-30T14:00:00.000Z', '2026-09-30T17:00:00.000Z'],
    ]);
    // cierre = inicio − 2 h
    expect(slots[0].cutoffAt.toISOString()).toBe('2026-09-29T18:00:00.000Z');
  });

  it('no genera franjas que ya cerraron (hoy 09:00 con anticipación de 2 h a las 08:00)', () => {
    expect(generateSlots('z1', [tpl(2, '09:00', '12:00')], opts)).toEqual([]);
  });

  it('el corte del mismo día adelanta el cierre de las franjas de esa fecha', () => {
    const [today, nextWeek] = generateSlots('z1', [tpl(2, '15:00', '18:00')], { ...opts, days: 8, sameDayCutoff: '11:00' });
    expect(today.cutoffAt.toISOString()).toBe('2026-09-29T16:00:00.000Z'); // 11:00 local
    expect(nextWeek.slotDate).toBe('2026-10-06');
    expect(nextWeek.cutoffAt.toISOString()).toBe('2026-10-06T16:00:00.000Z');
  });

  it('capacidad 0 = día sin servicio (no se generan franjas)', () => {
    expect(generateSlots('z1', [tpl(3, '09:00', '12:00', 0)], opts)).toEqual([]);
  });
});

describe('isBookable', () => {
  const now = new Date('2026-09-29T13:00:00Z');
  it('requiere cupo y que no haya cerrado', () => {
    expect(isBookable({ booked: 1, capacity: 2, cutoffAt: new Date('2026-09-29T14:00:00Z') }, now)).toBe(true);
    expect(isBookable({ booked: 2, capacity: 2, cutoffAt: new Date('2026-09-29T14:00:00Z') }, now)).toBe(false);
    expect(isBookable({ booked: 0, capacity: 2, cutoffAt: now }, now)).toBe(false);
  });
});
