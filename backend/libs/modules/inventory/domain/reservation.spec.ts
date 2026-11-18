import { ValidationError } from '../../../shared-kernel';
import { aggregateByStockKey, MAX_RESERVATION_LINES, normalizeReservationLines } from './reservation';

describe('normalizeReservationLines', () => {
  it('agrupa líneas repetidas y ordena por (variant_id, warehouse_id) para evitar deadlocks', () => {
    const lines = normalizeReservationLines([
      { variantId: 'c', warehouseId: 'w1', quantity: 1 },
      { variantId: 'a', warehouseId: 'w2', quantity: 2 },
      { variantId: 'a', warehouseId: 'w1', quantity: 1 },
      { variantId: 'c', warehouseId: 'w1', quantity: 4 },
    ]);
    expect(lines).toEqual([
      { variantId: 'a', warehouseId: 'w1', quantity: 1 },
      { variantId: 'a', warehouseId: 'w2', quantity: 2 },
      { variantId: 'c', warehouseId: 'w1', quantity: 5 },
    ]);
  });

  it('el orden resultante no depende del orden de entrada', () => {
    const forward = [
      { variantId: 'a', warehouseId: 'w', quantity: 1 },
      { variantId: 'b', warehouseId: 'w', quantity: 1 },
    ];
    expect(normalizeReservationLines([...forward].reverse())).toEqual(normalizeReservationLines(forward));
  });

  it.each([0, -1, 1.5])('rechaza cantidad %p', (quantity) => {
    expect(() => normalizeReservationLines([{ variantId: 'a', warehouseId: 'w', quantity }])).toThrow(ValidationError);
  });

  it('rechaza reservas vacías o demasiado grandes', () => {
    expect(() => normalizeReservationLines([])).toThrow(ValidationError);
    const many = Array.from({ length: MAX_RESERVATION_LINES + 1 }, (_, i) => ({
      variantId: `v${i}`,
      warehouseId: 'w',
      quantity: 1,
    }));
    expect(() => normalizeReservationLines(many)).toThrow(ValidationError);
  });
});

describe('aggregateByStockKey', () => {
  it('suma por clave y ordena', () => {
    expect(
      aggregateByStockKey([
        { variantId: 'b', warehouseId: 'w', quantity: 1 },
        { variantId: 'a', warehouseId: 'w', quantity: 2 },
        { variantId: 'b', warehouseId: 'w', quantity: 3 },
      ]),
    ).toEqual([
      { variantId: 'a', warehouseId: 'w', quantity: 2 },
      { variantId: 'b', warehouseId: 'w', quantity: 4 },
    ]);
  });
});
