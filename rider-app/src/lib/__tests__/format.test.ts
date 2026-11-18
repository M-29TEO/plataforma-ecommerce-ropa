import { addDays, formatDistance, formatDuration, formatIsoDate, formatMoney, formatTime, fromCents, isPositiveAmount, mondayOf, secondsLeft, toCents, todayIso } from '../format';
import { periodRange } from '../earnings';

describe('dinero', () => {
  it('convierte montos a centavos y de vuelta', () => {
    expect(toCents('12.5')).toBe(1250);
    expect(toCents('0.05')).toBe(5);
    expect(toCents(3)).toBe(300);
    expect(toCents('7,25')).toBe(725);
    expect(fromCents(1205)).toBe('12.05');
    expect(() => toCents('12.345')).toThrow();
    expect(() => toCents('-1')).toThrow();
  });

  it('formatea como en Ecuador', () => {
    expect(formatMoney('1234.5')).toBe('$1.234,50');
    expect(formatMoney('0')).toBe('$0,00');
    expect(formatMoney(null)).toBe('');
    expect(formatMoney('abc')).toBe('');
  });

  it('detecta montos positivos', () => {
    expect(isPositiveAmount('0.00')).toBe(false);
    expect(isPositiveAmount('15.00')).toBe(true);
    expect(isPositiveAmount(undefined)).toBe(false);
  });
});

describe('fechas en America/Guayaquil (UTC−5)', () => {
  it('muestra la hora local', () => {
    expect(formatTime('2026-10-08T15:04:00Z')).toBe('10:04');
    expect(formatTime('2026-10-08T03:30:00Z')).toBe('22:30');
  });

  it('hoy cambia a medianoche de Guayaquil, no de UTC', () => {
    expect(todayIso(new Date('2026-10-09T04:59:00Z'))).toBe('2026-10-08');
    expect(todayIso(new Date('2026-10-09T05:00:00Z'))).toBe('2026-10-09');
  });

  it('calcula lunes y rangos de la semana de liquidación', () => {
    expect(mondayOf('2026-10-08')).toBe('2026-10-05'); // jueves
    expect(mondayOf('2026-10-11')).toBe('2026-10-05'); // domingo
    expect(mondayOf('2026-10-05')).toBe('2026-10-05');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(periodRange('today', '2026-10-08')).toEqual({ from: '2026-10-08', to: '2026-10-08' });
    expect(periodRange('week', '2026-10-08')).toEqual({ from: '2026-10-05', to: '2026-10-08' });
    expect(periodRange('lastWeek', '2026-10-08')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
  });

  it('formatea fechas sin zona y duraciones', () => {
    expect(formatIsoDate('2026-10-05')).toBe('lun 5 oct');
    expect(formatDuration(3 * 3600_000 + 5 * 60_000)).toBe('3 h 05 min');
    expect(formatDuration(42 * 60_000)).toBe('42 min');
  });
});

describe('otros formatos', () => {
  it('distancias', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(4321)).toBe('4,3 km');
    expect(formatDistance(null)).toBe('');
  });

  it('segundos restantes de una oferta', () => {
    const now = Date.parse('2026-10-08T15:00:00Z');
    expect(secondsLeft('2026-10-08T15:00:44.200Z', now)).toBe(45);
    expect(secondsLeft('2026-10-08T14:59:00Z', now)).toBe(0);
  });
});
