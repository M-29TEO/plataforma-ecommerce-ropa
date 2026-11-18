import { AllocationShortageError, planAllocation, WarehouseAvailability } from './allocation';

const stock = (rows: [string, string, number][]): WarehouseAvailability[] =>
  rows.map(([variantId, warehouseId, available]) => ({ variantId, warehouseId, available }));

describe('planAllocation', () => {
  it('prefiere una sola bodega que cubra todo el pedido', () => {
    const lines = planAllocation(
      [
        { variantId: 'v1', quantity: 2 },
        { variantId: 'v2', quantity: 1 },
      ],
      stock([
        ['v1', 'wA', 5],
        ['v2', 'wA', 0],
        ['v1', 'wB', 2],
        ['v2', 'wB', 1],
      ]),
    );
    expect(lines).toEqual([
      { variantId: 'v1', warehouseId: 'wB', quantity: 2 },
      { variantId: 'v2', warehouseId: 'wB', quantity: 1 },
    ]);
  });

  it('entre varias bodegas completas elige la de más unidades', () => {
    const lines = planAllocation([{ variantId: 'v1', quantity: 1 }], stock([['v1', 'wA', 2], ['v1', 'wB', 9]]));
    expect(lines).toEqual([{ variantId: 'v1', warehouseId: 'wB', quantity: 1 }]);
  });

  it('si ninguna cubre todo, reparte la variante de la que más tiene a la que menos', () => {
    const lines = planAllocation([{ variantId: 'v1', quantity: 5 }], stock([['v1', 'wA', 2], ['v1', 'wB', 4]]));
    expect(lines).toEqual([
      { variantId: 'v1', warehouseId: 'wB', quantity: 4 },
      { variantId: 'v1', warehouseId: 'wA', quantity: 1 },
    ]);
  });

  it('retiro en tienda: solo cuenta la bodega indicada', () => {
    const rows = stock([['v1', 'wA', 1], ['v1', 'tienda', 3]]);
    expect(planAllocation([{ variantId: 'v1', quantity: 2 }], rows, { warehouseId: 'tienda' })).toEqual([
      { variantId: 'v1', warehouseId: 'tienda', quantity: 2 },
    ]);
    expect(() => planAllocation([{ variantId: 'v1', quantity: 4 }], rows, { warehouseId: 'tienda' })).toThrow(AllocationShortageError);
  });

  it('informa lo que falta por variante', () => {
    try {
      planAllocation([{ variantId: 'v1', quantity: 3 }, { variantId: 'v2', quantity: 1 }], stock([['v1', 'wA', 2]]));
      throw new Error('debía fallar');
    } catch (error) {
      expect(error).toBeInstanceOf(AllocationShortageError);
      expect((error as AllocationShortageError).code).toBe('INSUFFICIENT_STOCK');
      expect((error as AllocationShortageError).details).toEqual({
        shortages: [
          { variantId: 'v1', requested: 3, available: 2 },
          { variantId: 'v2', requested: 1, available: 0 },
        ],
      });
    }
  });
});
