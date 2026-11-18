import { parseCommissionScheme } from './commission';
import { EarningsDelivery, earningsPeriod, summarizeEarnings } from './earnings';

// Jueves 8 de octubre de 2026, 10:00 en Quito (UTC-5).
const NOW = new Date('2026-10-08T15:00:00Z');
const scheme = parseCommissionScheme({ per_delivery: 2.5, per_km: 0.3, bonus_tiers: [{ min_deliveries: 3, amount: 10 }] });

function delivery(over: Partial<EarningsDelivery>): EarningsDelivery {
  return {
    shipmentId: 'e',
    orderId: 'o',
    deliveredAt: NOW,
    distanceM: 3000,
    codAmount: '0.00',
    codCollected: null,
    codMethod: null,
    ...over,
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return undefined;
}

describe('Ganancias del motorizado', () => {
  it('período por defecto: del lunes de esta semana a hoy (hora de Quito)', () => {
    const p = earningsPeriod(undefined, undefined, NOW);
    expect(p).toMatchObject({ from: '2026-10-05', to: '2026-10-08' });
    expect(p.startAt.toISOString()).toBe('2026-10-05T05:00:00.000Z');
    expect(p.endAt.toISOString()).toBe('2026-10-09T05:00:00.000Z');
    // A las 23:30 de Quito del domingo ya es lunes en UTC, pero sigue siendo la semana anterior.
    expect(earningsPeriod(undefined, undefined, new Date('2026-10-12T04:30:00Z'))).toMatchObject({ from: '2026-10-05', to: '2026-10-11' });
  });

  it('valida el rango: fechas reales, from <= to y hasta 62 días', () => {
    expect(earningsPeriod('2026-08-08', '2026-10-08', NOW)).toMatchObject({ from: '2026-08-08' }); // 62 días
    expect(codeOf(() => earningsPeriod('2026-08-07', '2026-10-08', NOW))).toBe('EARNINGS_RANGE_TOO_LONG');
    expect(codeOf(() => earningsPeriod('2026-10-09', '2026-10-08', NOW))).toBe('INVALID_EARNINGS_PERIOD');
    expect(codeOf(() => earningsPeriod('2026-02-30', undefined, NOW))).toBe('INVALID_EARNINGS_PERIOD');
  });

  it('suma comisiones, efectivo por método, desglose diario y bono estimado', () => {
    const period = earningsPeriod('2026-10-05', '2026-10-08', NOW);
    const list = [
      // Lunes 5, 3 km: 2,50 + 3 × 0,30 = 3,40.
      delivery({ shipmentId: 'a', deliveredAt: new Date('2026-10-05T17:00:00Z') }),
      // Hoy, 1,25 km → 1,3 km cobrables: 2,50 + 0,39 = 2,89; contra entrega en efectivo.
      delivery({ shipmentId: 'b', deliveredAt: new Date('2026-10-08T14:00:00Z'), distanceM: 1250, codAmount: '34.50', codCollected: '34.50', codMethod: 'cash' }),
      // Hoy temprano (00:30 de Quito = 05:30 UTC): con tarjeta en el POS.
      delivery({ shipmentId: 'c', deliveredAt: new Date('2026-10-08T05:30:00Z'), codAmount: '20.00', codCollected: '20.00', codMethod: 'card_pos' }),
      // 23:59 de Quito del día 8 está dentro; el 9 a las 00:00 de Quito ya no.
      delivery({ shipmentId: 'fuera', deliveredAt: new Date('2026-10-09T05:00:00Z') }),
    ];
    const s = summarizeEarnings(list, scheme, period, NOW);
    expect(s.deliveries).toBe(3);
    expect(s.fees).toBe('9.69');
    expect(s.bonusEstimate).toBe('10.00');
    expect(s.codCollected).toEqual({ total: '54.50', cash: '34.50', card_pos: '20.00', deuna_qr: '0.00' });
    expect(s.today).toEqual({ deliveries: 2, fees: '6.29' });
    expect(s.byDay).toEqual([
      { date: '2026-10-05', deliveries: 1, fees: '3.40', codCollected: '0.00' },
      { date: '2026-10-06', deliveries: 0, fees: '0.00', codCollected: '0.00' },
      { date: '2026-10-07', deliveries: 0, fees: '0.00', codCollected: '0.00' },
      { date: '2026-10-08', deliveries: 2, fees: '6.29', codCollected: '54.50' },
    ]);
    expect(s.items.map((i) => i.shipmentId)).toEqual(['b', 'c', 'a']);
    expect(s.items[0]).toMatchObject({ fee: '2.89', codAmount: '34.50', codMethod: 'cash', distanceM: 1250 });
  });

  it('sin entregas: ceros y sin bono', () => {
    const s = summarizeEarnings([], scheme, earningsPeriod('2026-10-08', '2026-10-08', NOW), NOW);
    expect(s).toMatchObject({ deliveries: 0, fees: '0.00', bonusEstimate: '0.00', today: { deliveries: 0, fees: '0.00' }, items: [] });
    expect(s.byDay).toHaveLength(1);
  });
});
