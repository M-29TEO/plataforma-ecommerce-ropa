import { billableKm, deliveryFeeCents, parseCommissionScheme, volumeBonusCents } from './commission';
import {
  assertDifferentPayer,
  assertSettlementTransition,
  codControl,
  computeApproval,
  computeDraft,
  periodCloseAt,
  periodStartingOn,
  previousWeek,
  weekContaining,
} from './settlement';

const scheme = parseCommissionScheme({
  per_delivery: 2.5,
  per_km: '0.30',
  bonus_tiers: [
    { min_deliveries: 3, amount: 5 },
    { min_deliveries: 5, amount: 12.5 },
  ],
});

describe('Esquema de comisión', () => {
  it('interpreta números y strings como centavos', () => {
    expect(scheme).toEqual({
      perDeliveryCents: 250,
      perKmCents: 30,
      bonusTiers: [
        { minDeliveries: 3, amountCents: 500 },
        { minDeliveries: 5, amountCents: 1250 },
      ],
    });
    expect(parseCommissionScheme({ per_delivery: 2.5, per_km: 0.3 }).bonusTiers).toEqual([]);
  });

  it.each([
    ['no es objeto', null],
    ['monto negativo', { per_delivery: -1 }],
    ['3 decimales', { per_delivery: 2.555 }],
    ['todo en cero', { per_delivery: 0, per_km: 0 }],
    ['tramo sin mínimo', { per_delivery: 1, bonus_tiers: [{ amount: 5 }] }],
  ])('rechaza %s', (_name, raw) => {
    expect(() => parseCommissionScheme(raw)).toThrow(expect.objectContaining({ code: 'INVALID_COMMISSION_SCHEME' }));
  });

  it('comisión por entrega: fijo + km hacia arriba a 0,1 km', () => {
    expect(billableKm(4_530)).toBe(4.6);
    expect(billableKm(null)).toBe(0);
    expect(deliveryFeeCents(scheme, 4_530)).toBe(250 + 138); // 4.6 km × 0.30
    expect(deliveryFeeCents(scheme, null)).toBe(250);
  });

  it('bono semanal: el mayor tramo alcanzado, no la suma', () => {
    expect(volumeBonusCents(scheme, 2)).toBe(0);
    expect(volumeBonusCents(scheme, 4)).toBe(500);
    expect(volumeBonusCents(scheme, 9)).toBe(1250);
  });
});

describe('Período semanal (lunes a domingo, America/Guayaquil)', () => {
  it('semana de una fecha y semana anterior', () => {
    expect(weekContaining('2026-09-30')).toEqual({ start: '2026-09-28', end: '2026-10-04' }); // miércoles
    expect(weekContaining('2026-10-04')).toEqual({ start: '2026-09-28', end: '2026-10-04' }); // domingo
    // Lunes 5 de octubre 03:00 local (08:00 UTC): cierra la semana del 28 de septiembre.
    expect(previousWeek(new Date('2026-10-05T08:00:00Z'))).toEqual({ start: '2026-09-28', end: '2026-10-04' });
    // Domingo 4 de octubre 23:30 local = lunes 04:30 UTC: todavía es la semana en curso.
    expect(previousWeek(new Date('2026-10-05T04:30:00Z'))).toEqual({ start: '2026-09-21', end: '2026-09-27' });
  });

  it('cierra el lunes siguiente a las 00:00 locales', () => {
    expect(periodCloseAt({ start: '2026-09-28', end: '2026-10-04' }).toISOString()).toBe('2026-10-05T05:00:00.000Z');
  });

  it('periodStart manual: lunes y semana ya cerrada', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    expect(periodStartingOn('2026-09-21', now)).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(() => periodStartingOn('2026-09-22', now)).toThrow(expect.objectContaining({ code: 'INVALID_SETTLEMENT_PERIOD' }));
    expect(() => periodStartingOn('2026-09-28', now)).toThrow(expect.objectContaining({ code: 'SETTLEMENT_PERIOD_NOT_CLOSED' }));
  });
});

describe('Liquidación', () => {
  const deliveries = [
    { shipmentId: 'a', distanceM: 3_000, codMethod: 'cash', codCollected: '25.00' },
    { shipmentId: 'b', distanceM: 5_000, codMethod: 'deuna_qr', codCollected: '40.00' },
    { shipmentId: 'c', distanceM: 1_000, codMethod: null, codCollected: null },
  ];

  it('borrador: comisiones + bono; solo el efectivo cuenta como cobrado; propone retener el saldo', () => {
    const d = computeDraft(scheme, deliveries, 2_500);
    expect(d.items).toEqual([
      { shipmentId: 'a', feeCents: 250 + 90, codCents: 2_500 },
      { shipmentId: 'b', feeCents: 250 + 150, codCents: 0 },
      { shipmentId: 'c', feeCents: 250 + 30, codCents: 0 },
    ]);
    expect(d).toMatchObject({
      deliveriesCount: 3,
      grossFeesCents: 1_020,
      bonusesCents: 500,
      codCollectedCents: 2_500,
      codRemittedCents: 0,
      // Debe $25 en efectivo y gana $15.20: se retiene todo lo que gana, no más.
      deductionsCents: 1_520,
      netPayableCents: 0,
    });
  });

  it('aprobación: el efectivo rendido baja la retención; lo no cubierto queda en el saldo', () => {
    // Gana $15.20, tiene $25 en mano y rinde $20: se retienen $5.
    expect(computeApproval({ grossFeesCents: 1_020, bonusesCents: 500, codBalanceCents: 2_500, codRemittedCents: 2_000 })).toEqual({
      deductionsCents: 500,
      netPayableCents: 1_020,
      codBalanceAfterCents: 0,
    });
    // No rinde nada y debe más de lo que gana: se retiene todo y quedan $9.80 pendientes.
    expect(computeApproval({ grossFeesCents: 1_020, bonusesCents: 500, codBalanceCents: 2_500, codRemittedCents: 0 })).toEqual({
      deductionsCents: 1_520,
      netPayableCents: 0,
      codBalanceAfterCents: 980,
    });
    expect(() => computeApproval({ grossFeesCents: 0, bonusesCents: 0, codBalanceCents: 1_000, codRemittedCents: 1_001 })).toThrow(
      expect.objectContaining({ code: 'COD_REMITTED_EXCEEDS_BALANCE' }),
    );
  });

  it('transiciones permitidas', () => {
    expect(() => assertSettlementTransition('x', 'draft', 'approved')).not.toThrow();
    expect(() => assertSettlementTransition('x', 'disputed', 'approved')).not.toThrow();
    expect(() => assertSettlementTransition('x', 'approved', 'paid')).not.toThrow();
    for (const [from, to] of [['draft', 'paid'], ['paid', 'approved'], ['approved', 'disputed']] as const) {
      expect(() => assertSettlementTransition('x', from, to)).toThrow(expect.objectContaining({ code: 'INVALID_SETTLEMENT_TRANSITION' }));
    }
  });

  it('control de efectivo contra el límite', () => {
    expect(codControl('150.00', '200.00')).toEqual({ codBalance: '150.00', codLimit: '200.00', codAvailable: '50.00', overLimit: false });
    expect(codControl('230.50', '200.00')).toMatchObject({ codAvailable: '0.00', overLimit: true });
  });
});

describe('Segregación aprobar / pagar', () => {
  it('quien aprobó no puede marcar como pagada', () => {
    expect(() => assertDifferentPayer('x', 'u1', 'u1')).toThrow(expect.objectContaining({ code: 'SETTLEMENT_SAME_APPROVER' }));
    expect(() => assertDifferentPayer('x', 'u1', 'u2')).not.toThrow();
  });
});
