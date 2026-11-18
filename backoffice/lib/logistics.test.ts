import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  countByPresence,
  filterRiders,
  formatDistance,
  haversineMeters,
  isOverCodLimit,
  isStale,
  lastClosedWeek,
  type LiveRider,
  mondayOf,
  needsRefetch,
  normalizeMoneyInput,
  rankRiders,
  recentWeeks,
  reduceRiders,
  type Settlement,
  settlementActions,
  settlementTotals,
} from './logistics';

function rider(id: string, patch: Partial<LiveRider> = {}): LiveRider {
  return {
    riderId: id,
    userId: `u-${id}`,
    name: `Rider ${id}`,
    phone: null,
    vehicleType: 'moto',
    plate: null,
    status: 'active',
    presence: 'available',
    codBalance: '0.00',
    codLimit: '100.00',
    ratingAvg: null,
    lastLocation: { lat: -0.18, lng: -78.47, heading: 0, speedKmh: 20, recordedAt: '2026-10-07T15:00:00.000Z' },
    activeShipments: [],
    ...patch,
  };
}

describe('haversineMeters', () => {
  it('es 0 para el mismo punto', () => {
    expect(haversineMeters({ lat: -0.18, lng: -78.47 }, { lat: -0.18, lng: -78.47 })).toBe(0);
  });
  it('un grado de latitud ≈ 111,2 km', () => {
    expect(haversineMeters({ lat: 0, lng: -78 }, { lat: 1, lng: -78 })).toBeCloseTo(111_195, -1);
  });
  it('Quito (Plaza Grande) → Mitad del Mundo ≈ 25 km y es simétrica', () => {
    const a = { lat: -0.2201, lng: -78.5123 };
    const b = { lat: -0.0022, lng: -78.4558 };
    const d = haversineMeters(a, b);
    expect(d).toBeGreaterThan(24_000);
    expect(d).toBeLessThan(26_000);
    expect(haversineMeters(b, a)).toBeCloseTo(d, 6);
  });
  it('formatDistance', () => {
    expect(formatDistance(null)).toBe('—');
    expect(formatDistance(850.4)).toBe('850 m');
    expect(formatDistance(2345)).toBe('2,3 km');
  });
});

describe('reduceRiders', () => {
  const base = [rider('a'), rider('b', { presence: 'busy' })];

  it('actualiza la posición con un evento más nuevo', () => {
    const next = reduceRiders(base, {
      type: 'location',
      data: { riderId: 'a', lat: -0.2, lng: -78.5, heading: 90, speedKmh: 30, recordedAt: '2026-10-07T15:01:00.000Z', shipmentId: null },
    });
    expect(next).not.toBe(base);
    expect(next[0].lastLocation).toEqual({ lat: -0.2, lng: -78.5, heading: 90, speedKmh: 30, recordedAt: '2026-10-07T15:01:00.000Z' });
    expect(next[1]).toBe(base[1]);
  });

  it('descarta posiciones más viejas o iguales a la que ya tiene', () => {
    const old = { riderId: 'a', lat: 1, lng: 1, heading: null, speedKmh: null, recordedAt: '2026-10-07T14:59:00.000Z', shipmentId: null };
    expect(reduceRiders(base, { type: 'location', data: old })).toBe(base);
    expect(reduceRiders(base, { type: 'location', data: { ...old, recordedAt: '2026-10-07T15:00:00.000Z' } })).toBe(base);
  });

  it('acepta la primera posición de un motorizado sin posición', () => {
    const list = [rider('a', { lastLocation: null })];
    const next = reduceRiders(list, { type: 'location', data: { riderId: 'a', lat: 1, lng: 2, heading: null, speedKmh: null, recordedAt: '2026-10-07T10:00:00Z', shipmentId: null } });
    expect(next[0].lastLocation?.lat).toBe(1);
  });

  it('ignora eventos de motorizados desconocidos (y pide recargar)', () => {
    const ev = { type: 'location' as const, data: { riderId: 'x', lat: 1, lng: 1, heading: null, speedKmh: null, recordedAt: '2026-10-07T16:00:00Z', shipmentId: null } };
    expect(reduceRiders(base, ev)).toBe(base);
    expect(needsRefetch(base, ev)).toBe(true);
  });

  it('cambia la presencia y descarta cambios más viejos', () => {
    const next = reduceRiders(base, { type: 'presence', data: { riderId: 'a', presence: 'break', changedAt: '2026-10-07T15:05:00Z' } });
    expect(next[0].presence).toBe('break');
    const stale = reduceRiders(next, { type: 'presence', data: { riderId: 'a', presence: 'available', changedAt: '2026-10-07T15:04:00Z' } });
    expect(stale).toBe(next);
    expect(reduceRiders(next, { type: 'presence', data: { riderId: 'a', presence: 'break', changedAt: '2026-10-07T15:05:00Z' } })).toBe(next);
  });

  it('agrega un envío asignado y pide recargar para conocer su destino', () => {
    const ev = { type: 'status' as const, data: { shipmentId: 's1', orderId: 'o1', riderId: 'a', status: 'assigned' } };
    const next = reduceRiders(base, ev);
    expect(next[0].activeShipments).toEqual([{ shipmentId: 's1', orderId: 'o1', status: 'assigned', dropoff: null }]);
    expect(needsRefetch(base, ev)).toBe(true);
  });

  it('actualiza el estado de un envío conocido conservando su destino', () => {
    const list = [rider('a', { activeShipments: [{ shipmentId: 's1', orderId: 'o1', status: 'assigned', dropoff: { lat: 1, lng: 2 } }] })];
    const ev = { type: 'status' as const, data: { shipmentId: 's1', orderId: 'o1', riderId: 'a', status: 'in_transit' } };
    const next = reduceRiders(list, ev);
    expect(next[0].activeShipments[0]).toEqual({ shipmentId: 's1', orderId: 'o1', status: 'in_transit', dropoff: { lat: 1, lng: 2 } });
    expect(needsRefetch(list, ev)).toBe(false);
    expect(reduceRiders(next, ev)).toBe(next);
  });

  it('quita el envío al entregarse o cancelarse', () => {
    const list = [rider('a', { activeShipments: [{ shipmentId: 's1', orderId: 'o1', status: 'arriving', dropoff: null }] })];
    const next = reduceRiders(list, { type: 'status', data: { shipmentId: 's1', orderId: 'o1', riderId: 'a', status: 'delivered' } });
    expect(next[0].activeShipments).toEqual([]);
    expect(reduceRiders(base, { type: 'status', data: { shipmentId: 'zz', orderId: 'o', riderId: null, status: 'ready_for_pickup' } })).toBe(base);
  });

  it('una reasignación mueve el envío (con su destino) al otro motorizado', () => {
    const list = [rider('a', { activeShipments: [{ shipmentId: 's1', orderId: 'o1', status: 'assigned', dropoff: { lat: 1, lng: 2 } }] }), rider('b')];
    const ev = { type: 'status' as const, data: { shipmentId: 's1', orderId: 'o1', riderId: 'b', status: 'assigned' } };
    const next = reduceRiders(list, ev);
    expect(next[0].activeShipments).toEqual([]);
    expect(next[1].activeShipments).toEqual([{ shipmentId: 's1', orderId: 'o1', status: 'assigned', dropoff: { lat: 1, lng: 2 } }]);
  });
});

describe('estado de los motorizados', () => {
  const now = Date.parse('2026-10-07T15:10:00Z');
  it('isStale: más de 5 min sin reportar o sin posición', () => {
    expect(isStale(null, now)).toBe(true);
    expect(isStale({ lat: 0, lng: 0, heading: null, speedKmh: null, recordedAt: '2026-10-07T15:06:00Z' }, now)).toBe(false);
    expect(isStale({ lat: 0, lng: 0, heading: null, speedKmh: null, recordedAt: '2026-10-07T15:04:59Z' }, now)).toBe(true);
  });
  it('isOverCodLimit', () => {
    expect(isOverCodLimit({ codBalance: '100.00', codLimit: '100.00' })).toBe(false);
    expect(isOverCodLimit({ codBalance: '100.01', codLimit: '100.00' })).toBe(true);
  });
  it('conteos, búsqueda sin tildes y filtro por presencia', () => {
    const list = [rider('a', { name: 'José Pérez', plate: 'PBA-1234' }), rider('b', { presence: 'busy', name: 'Ana' }), rider('c', { presence: 'offline' })];
    expect(countByPresence(list)).toEqual({ available: 1, busy: 1, break: 0, offline: 1 });
    expect(filterRiders(list, 'jose', '').map((r) => r.riderId)).toEqual(['a']);
    expect(filterRiders(list, 'pba', '').map((r) => r.riderId)).toEqual(['a']);
    expect(filterRiders(list, '', 'busy').map((r) => r.riderId)).toEqual(['b']);
  });
});

describe('rankRiders', () => {
  const dropoff = { lat: -0.18, lng: -78.47 };
  it('disponibles primero y, dentro de cada presencia, por cercanía; sin posición al final', () => {
    const list = [
      rider('lejos', { lastLocation: { lat: -0.25, lng: -78.47, heading: null, speedKmh: null, recordedAt: '' } }),
      rider('ocupado-cerca', { presence: 'busy', lastLocation: { lat: -0.1801, lng: -78.47, heading: null, speedKmh: null, recordedAt: '' } }),
      rider('sin-pos', { lastLocation: null }),
      rider('cerca', { lastLocation: { lat: -0.19, lng: -78.47, heading: null, speedKmh: null, recordedAt: '' } }),
      rider('offline', { presence: 'offline' }),
    ];
    const ranked = rankRiders(list, dropoff);
    expect(ranked.map((r) => r.rider.riderId)).toEqual(['cerca', 'lejos', 'sin-pos', 'ocupado-cerca', 'offline']);
    expect(ranked[0].distanceM).toBeCloseTo(1112, -1);
    expect(ranked[2].distanceM).toBeNull();
  });
  it('sin destino: solo por presencia', () => {
    const ranked = rankRiders([rider('b', { presence: 'break' }), rider('a')], null);
    expect(ranked.map((r) => r.rider.riderId)).toEqual(['a', 'b']);
    expect(ranked.every((r) => r.distanceM === null)).toBe(true);
  });
});

describe('liquidaciones', () => {
  it('semanas: lunes de la semana, última semana cerrada y anteriores', () => {
    expect(mondayOf('2026-10-07')).toBe('2026-10-05'); // miércoles
    expect(mondayOf('2026-10-05')).toBe('2026-10-05');
    expect(mondayOf('2026-10-11')).toBe('2026-10-05'); // domingo
    expect(lastClosedWeek('2026-10-07')).toBe('2026-09-28');
    expect(recentWeeks('2026-10-07', 3)).toEqual(['2026-09-28', '2026-09-21', '2026-09-14']);
    expect(addDaysIso('2026-12-29', 6)).toBe('2027-01-04');
  });
  it('acciones según estado', () => {
    expect(settlementActions('draft')).toEqual({ approve: true, dispute: true, markPaid: false });
    expect(settlementActions('disputed')).toEqual({ approve: true, dispute: false, markPaid: false });
    expect(settlementActions('approved')).toEqual({ approve: false, dispute: false, markPaid: true });
    expect(settlementActions('paid')).toEqual({ approve: false, dispute: false, markPaid: false });
  });
  it('normalizeMoneyInput', () => {
    expect(normalizeMoneyInput('12,5')).toBe('12.50');
    expect(normalizeMoneyInput(' 0 ')).toBe('0.00');
    expect(normalizeMoneyInput('12.345')).toBeNull();
    expect(normalizeMoneyInput('-1')).toBeNull();
    expect(normalizeMoneyInput('abc')).toBeNull();
  });
  it('totales sin errores de coma flotante', () => {
    const s = (patch: Partial<Settlement>): Settlement => ({
      id: 'x',
      riderId: 'r',
      periodStart: '2026-09-28',
      periodEnd: '2026-10-04',
      deliveriesCount: 1,
      grossFees: '0.10',
      bonuses: '0.20',
      deductions: '0.00',
      codCollected: '0.00',
      codRemitted: '0.00',
      netPayable: '0.30',
      status: 'draft',
      approvedBy: null,
      paidAt: null,
      ...patch,
    });
    const t = settlementTotals([s({}), s({ deliveriesCount: 4, netPayable: '10.05' })]);
    expect(t).toMatchObject({ count: 2, deliveries: 5, grossFees: 0.2, bonuses: 0.4, netPayable: 10.35 });
  });
});
