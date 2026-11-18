import { dueReminder, firstReminderCutoff } from './abandoned-cart';

describe('dueReminder', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  it('antes de 1 h no hay recordatorio', () => {
    expect(dueReminder(0, ago(0.5), now)).toBeNull();
  });

  it('1 h, 24 h y 72 h en orden', () => {
    expect(dueReminder(0, ago(1), now)?.stage).toBe(1);
    expect(dueReminder(1, ago(5), now)).toBeNull();
    expect(dueReminder(1, ago(24), now)?.stage).toBe(2);
    expect(dueReminder(2, ago(48), now)).toBeNull();
    expect(dueReminder(2, ago(72), now)?.stage).toBe(3);
  });

  it('después del tercero no hay más', () => {
    expect(dueReminder(3, ago(500), now)).toBeNull();
  });

  it('si el job estuvo detenido, envía solo la etapa más avanzada vencida', () => {
    expect(dueReminder(0, ago(80), now)?.stage).toBe(3);
    expect(dueReminder(0, ago(30), now)?.stage).toBe(2);
  });

  it('corte de candidatos: 1 h antes de ahora', () => {
    expect(firstReminderCutoff(now).toISOString()).toBe('2026-10-01T11:00:00.000Z');
  });
});
