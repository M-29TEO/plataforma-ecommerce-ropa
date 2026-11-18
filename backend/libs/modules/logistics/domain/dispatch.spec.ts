import {
  assertOfferOpen,
  DispatchCandidate,
  ineligibility,
  isDispatchable,
  OfferClosedError,
  OfferExpiredError,
  rankCandidates,
  scoreCandidate,
} from './dispatch';

const NOW = new Date('2026-10-08T15:00:00Z');
const WAREHOUSE = { lat: -0.15, lng: -78.485 };

function candidate(over: Partial<DispatchCandidate> = {}): DispatchCandidate {
  return {
    riderId: 'r-1',
    presence: 'available',
    maxConcurrent: 3,
    activeShipments: 0,
    ratingAvg: '5.00',
    codLimit: '200.00',
    codBalance: '0.00',
    position: { ...WAREHOUSE, recordedAt: new Date(NOW.getTime() - 60_000) },
    ...over,
  };
}

describe('Despacho automático: elegibilidad y puntaje', () => {
  const target = { pickup: WAREHOUSE, codAmount: '0.00' };

  it('descarta a quien no está disponible, está lleno, no tiene posición reciente o no puede recibir el efectivo', () => {
    expect(ineligibility(candidate(), target, NOW)).toBeNull();
    expect(ineligibility(candidate({ presence: 'busy', activeShipments: 1 }), target, NOW)).toBeNull();
    expect(ineligibility(candidate({ presence: 'break' }), target, NOW)).toBe('presence');
    expect(ineligibility(candidate({ presence: 'offline' }), target, NOW)).toBe('presence');
    expect(ineligibility(candidate({ activeShipments: 3 }), target, NOW)).toBe('capacity');
    expect(ineligibility(candidate({ presence: 'busy', activeShipments: 3 }), target, NOW)).toBe('capacity');
    expect(ineligibility(candidate({ position: null }), target, NOW)).toBe('stale_position');
    expect(ineligibility(candidate({ position: { ...WAREHOUSE, recordedAt: new Date(NOW.getTime() - 16 * 60_000) } }), target, NOW)).toBe('stale_position');
    const cod = { pickup: WAREHOUSE, codAmount: '34.50' };
    expect(ineligibility(candidate({ codBalance: '170.00' }), cod, NOW)).toBe('cod');
    expect(ineligibility(candidate({ codBalance: '165.50' }), cod, NOW)).toBeNull(); // justo 34,50 disponibles
  });

  it('el puntaje premia la cercanía a la bodega, la calificación y tener menos carga', () => {
    const atWarehouse = scoreCandidate(candidate(), target);
    expect(atWarehouse.score).toBe(100);
    expect(atWarehouse.breakdown).toMatchObject({ distanceM: 0, distancePts: 70, rating: 5, ratingPts: 20, loadPts: 10 });

    // ~5 km al sur: la mitad de los puntos de distancia.
    const far = scoreCandidate(candidate({ position: { lat: -0.195, lng: -78.485, recordedAt: NOW } }), target);
    expect(far.breakdown.distanceM).toBeGreaterThan(4900);
    expect(far.breakdown.distanceM).toBeLessThan(5100);
    expect(far.breakdown.distancePts).toBeCloseTo(35, 0);

    // Más de 10 km: 0 puntos por distancia; calificación 3 = 10 puntos; 2 de 3 envíos = 3,33 puntos.
    const worst = scoreCandidate(candidate({ position: { lat: -0.3, lng: -78.485, recordedAt: NOW }, ratingAvg: '3.00', activeShipments: 2 }), target);
    expect(worst.breakdown).toMatchObject({ distancePts: 0, ratingPts: 10, loadPts: 3.33 });
    expect(worst.score).toBeCloseTo(13.3333, 3);

    // Sin bodega ni destino conocidos: sin distancia, desempatan calificación y carga.
    expect(scoreCandidate(candidate(), { pickup: null, codAmount: '0' }).breakdown).toMatchObject({ distanceM: null, distancePts: 0 });
  });

  it('ordena del mejor al peor, sin los no elegibles, con desempate estable', () => {
    const near = candidate({ riderId: 'cerca', position: { lat: -0.151, lng: -78.485, recordedAt: NOW } });
    const far = candidate({ riderId: 'lejos', position: { lat: -0.19, lng: -78.485, recordedAt: NOW } });
    const busy = candidate({ riderId: 'lleno', activeShipments: 3 });
    const twinB = candidate({ riderId: 'b' });
    const twinA = candidate({ riderId: 'a' });
    expect(rankCandidates([far, busy, near], target, NOW).map((c) => c.riderId)).toEqual(['cerca', 'lejos']);
    expect(rankCandidates([twinB, twinA], target, NOW).map((c) => c.riderId)).toEqual(['a', 'b']);
    expect(rankCandidates([busy], target, NOW)).toEqual([]);
  });

  it('solo se despachan envíos de salida con motorizado, sin motorizado y pendientes o listos', () => {
    const base = { status: 'ready_for_pickup', riderId: null, carrierType: 'rider', direction: 'outbound' };
    expect(isDispatchable(base)).toBe(true);
    expect(isDispatchable({ ...base, status: 'pending' })).toBe(true);
    expect(isDispatchable({ ...base, status: 'accepted', riderId: 'r' })).toBe(false);
    expect(isDispatchable({ ...base, riderId: 'r' })).toBe(false);
    expect(isDispatchable({ ...base, carrierType: 'courier' })).toBe(false);
    expect(isDispatchable({ ...base, direction: 'return' })).toBe(false);
  });

  it('una oferta se responde solo abierta y sin vencer', () => {
    const later = new Date(NOW.getTime() + 30_000);
    expect(() => assertOfferOpen({ response: null, expiresAt: later }, NOW)).not.toThrow();
    expect(() => assertOfferOpen({ response: null, expiresAt: NOW }, NOW)).toThrow(OfferExpiredError);
    expect(() => assertOfferOpen({ response: 'expired', expiresAt: later }, NOW)).toThrow(OfferExpiredError);
    expect(() => assertOfferOpen({ response: 'accepted', expiresAt: later }, NOW)).toThrow(OfferClosedError);
    expect(() => assertOfferOpen({ response: 'cancelled', expiresAt: later }, NOW)).toThrow(OfferClosedError);
  });
});
