import {
  assertCanEndShift,
  onDemandShiftWindow,
  scheduledShiftCovering,
  ShiftHasActiveShipmentsError,
  ShiftRecord,
  shiftView,
} from './shift';

const NOW = new Date('2026-10-08T15:00:00Z');

function shift(over: Partial<ShiftRecord>): ShiftRecord {
  return {
    id: 's',
    riderId: 'r',
    zoneId: null,
    startsAt: new Date('2026-10-08T13:00:00Z'),
    endsAt: new Date('2026-10-08T21:00:00Z'),
    status: 'scheduled',
    checkedInAt: null,
    ...over,
  };
}

describe('Turnos del motorizado', () => {
  it('activa el turno programado que cubre la hora actual (el que empezó antes)', () => {
    const later = shift({ id: 'tarde', startsAt: new Date('2026-10-08T14:00:00Z') });
    const earlier = shift({ id: 'temprano' });
    const future = shift({ id: 'futuro', startsAt: new Date('2026-10-08T16:00:00Z') });
    const done = shift({ id: 'cerrado', status: 'completed' });
    expect(scheduledShiftCovering([later, future, earlier, done], NOW)?.id).toBe('temprano');
    expect(scheduledShiftCovering([future, done], NOW)).toBeNull();
    // El fin es exclusivo.
    expect(scheduledShiftCovering([shift({ endsAt: NOW })], NOW)).toBeNull();
  });

  it('un turno a demanda dura las horas configuradas desde ahora', () => {
    expect(onDemandShiftWindow(NOW, 8)).toEqual({ startsAt: NOW, endsAt: new Date('2026-10-08T23:00:00Z') });
    expect(() => onDemandShiftWindow(NOW, 0)).toThrow(/turno/);
    expect(() => onDemandShiftWindow(NOW, 25)).toThrow(/turno/);
  });

  it('vista: inicio real (check-in), fin planificado y fin real solo al cerrar', () => {
    const active = shift({ status: 'active', checkedInAt: new Date('2026-10-08T13:05:00Z') });
    expect(shiftView(active)).toEqual({
      id: 's',
      status: 'active',
      startedAt: '2026-10-08T13:05:00.000Z',
      plannedEndAt: '2026-10-08T21:00:00.000Z',
      endedAt: null,
    });
    const closed = shiftView({ ...active, status: 'completed', endsAt: NOW });
    expect(closed).toMatchObject({ status: 'completed', endedAt: NOW.toISOString() });
  });

  it('no se cierra el turno con envíos en curso', () => {
    expect(() => assertCanEndShift([])).not.toThrow();
    expect(() => assertCanEndShift(['e-1'])).toThrow(ShiftHasActiveShipmentsError);
  });
});
