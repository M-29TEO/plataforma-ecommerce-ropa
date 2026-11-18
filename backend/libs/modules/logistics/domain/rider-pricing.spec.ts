import { decideDelivery } from './delivery-rules';
import { chargeableWeightKg, riderPrice } from './rider-pricing';

const zone = { baseFee: '2.50', feePerKm: '0.35', feePerExtraKg: '0.50', freeShippingThreshold: '60.00' };

describe('RiderPricing', () => {
  it('base + km (hacia arriba a 0,1 km) + kg extra sobre 2 kg', () => {
    const p = riderPrice({ zone, distanceM: 4_530, weightG: 3_200, volumeCm3: 0, merchandiseTotal: '40.00' });
    // 2.50 + 4.6 km × 0.35 (1.61) + 2 kg extra × 0.50 (1.00)
    expect(p.priceCents).toBe(250 + 161 + 100);
    expect(p.breakdown).toMatchObject({ distanceKm: 4.6, distanceFee: '1.61', chargeableKg: 3.2, extraKg: 2, weightFee: '1.00', freeShipping: false });
  });

  it('el peso volumétrico cuenta si es mayor', () => {
    expect(chargeableWeightKg(500, 40 * 30 * 20)).toBe(4.8);
    expect(riderPrice({ zone, distanceM: 0, weightG: 500, volumeCm3: 40 * 30 * 20, merchandiseTotal: '0' }).breakdown.extraKg).toBe(3);
  });

  it('envío gratis desde el umbral de la zona', () => {
    expect(riderPrice({ zone, distanceM: 9_000, weightG: 1_000, volumeCm3: 0, merchandiseTotal: '60.00' }).priceCents).toBe(0);
    expect(riderPrice({ zone: { ...zone, freeShippingThreshold: null }, distanceM: 0, weightG: 1_000, volumeCm3: 0, merchandiseTotal: '999.00' }).priceCents).toBe(250);
  });
});

describe('DeliveryRulesEngine', () => {
  const riderZone = { deliveryMode: 'rider' as const, maxWeightKg: 15, active: true };

  it('motorizado solo con zona propia, peso admitido y franja con cupo', () => {
    expect(decideDelivery({ zone: riderZone, weightKg: 2, bookableSlots: 3 })).toEqual({ type: 'rider' });
    expect(decideDelivery({ zone: { ...riderZone, deliveryMode: 'both' }, weightKg: 2, bookableSlots: 1 })).toEqual({ type: 'rider' });
  });

  it.each([
    ['sin zona', null, 2, 3, 'NO_ZONE'],
    ['zona inactiva', { ...riderZone, active: false }, 2, 3, 'NO_ZONE'],
    ['zona solo courier', { ...riderZone, deliveryMode: 'courier' as const }, 2, 3, 'COURIER_ONLY_ZONE'],
    ['exceso de peso', riderZone, 16, 3, 'OVERWEIGHT'],
    ['sin cupo', riderZone, 2, 0, 'NO_SLOT_CAPACITY'],
  ])('%s → courier', (_name, z, weightKg, bookableSlots, reason) => {
    expect(decideDelivery({ zone: z, weightKg, bookableSlots })).toEqual({ type: 'courier', reason });
  });
});
