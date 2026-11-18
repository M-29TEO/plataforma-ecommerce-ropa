import { AdjustmentBelowReservedError, InvalidAdjustmentError } from './errors';
import { compareStockKey, crossedBelowThreshold, planAdjustment } from './stock';

describe('crossedBelowThreshold', () => {
  it.each([
    [5, 3, 3, true], // cruza justo al punto de reorden
    [4, 1, 3, true], // cruza por debajo
    [3, 2, 3, false], // ya estaba en el umbral
    [2, 1, 3, false], // ya estaba por debajo
    [10, 4, 3, false], // baja pero sigue por encima
    [2, 5, 3, false], // sube: nunca emite
  ])('antes=%i después=%i reorden=%i → %s', (before, after, rp, expected) => {
    expect(crossedBelowThreshold(before, after, rp)).toBe(expected);
  });
});

describe('planAdjustment', () => {
  const current = { onHand: 10, reserved: 4 };

  it('ajuste con signo', () => {
    expect(planAdjustment(current, { type: 'adjustment', delta: 3 })).toEqual({ delta: 3, newOnHand: 13 });
    expect(planAdjustment(current, { type: 'adjustment', delta: -6 })).toEqual({ delta: -6, newOnHand: 4 });
  });

  it('rechaza ajustes de cero o no enteros', () => {
    expect(() => planAdjustment(current, { type: 'adjustment', delta: 0 })).toThrow(InvalidAdjustmentError);
    expect(() => planAdjustment(current, { type: 'adjustment', delta: 1.5 })).toThrow(InvalidAdjustmentError);
  });

  it('daño siempre resta', () => {
    expect(planAdjustment(current, { type: 'damage', quantity: 2 })).toEqual({ delta: -2, newOnHand: 8 });
    expect(() => planAdjustment(current, { type: 'damage', quantity: 0 })).toThrow(InvalidAdjustmentError);
  });

  it('conteo físico calcula el delta contra on_hand (incluido delta 0)', () => {
    expect(planAdjustment(current, { type: 'count', countedQuantity: 7 })).toEqual({ delta: -3, newOnHand: 7 });
    expect(planAdjustment(current, { type: 'count', countedQuantity: 10 })).toEqual({ delta: 0, newOnHand: 10 });
    expect(() => planAdjustment(current, { type: 'count', countedQuantity: -1 })).toThrow(InvalidAdjustmentError);
  });

  it('no permite dejar menos unidades físicas que las reservadas', () => {
    expect(() => planAdjustment(current, { type: 'adjustment', delta: -7 })).toThrow(AdjustmentBelowReservedError);
    expect(() => planAdjustment(current, { type: 'count', countedQuantity: 3 })).toThrow(AdjustmentBelowReservedError);
  });

  it('sin fila de stock parte de cero y no permite negativos', () => {
    expect(planAdjustment(null, { type: 'adjustment', delta: 5 })).toEqual({ delta: 5, newOnHand: 5 });
    expect(() => planAdjustment(null, { type: 'damage', quantity: 1 })).toThrow(AdjustmentBelowReservedError);
  });
});

describe('compareStockKey', () => {
  it('ordena por variante y luego por bodega', () => {
    const keys = [
      { variantId: 'b', warehouseId: '1' },
      { variantId: 'a', warehouseId: '2' },
      { variantId: 'a', warehouseId: '1' },
    ];
    expect([...keys].sort(compareStockKey)).toEqual([
      { variantId: 'a', warehouseId: '1' },
      { variantId: 'a', warehouseId: '2' },
      { variantId: 'b', warehouseId: '1' },
    ]);
  });
});
