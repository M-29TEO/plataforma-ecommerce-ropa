import { ValidationError } from '../../../shared-kernel';
import { InvalidPurchaseOrderTransitionError, OverReceiptError } from './errors';
import { generatePurchaseOrderNumber, PurchaseOrder } from './purchase-order';

function draft() {
  return PurchaseOrder.create({
    tenantId: 't',
    supplierId: 's',
    warehouseId: 'w',
    number: 'OC-1',
    expectedAt: null,
    createdBy: null,
    items: [
      { variantId: 'v1', qtyOrdered: 10, unitCost: '4.10' },
      { variantId: 'v2', qtyOrdered: 3, unitCost: 12.5 },
    ],
  });
}

describe('PurchaseOrder', () => {
  it('se crea en draft y calcula el total en centavos (sin errores de coma flotante)', () => {
    const po = draft().toJSON();
    expect(po.status).toBe('draft');
    expect(po.total).toBe('78.50'); // 10 × 4.10 + 3 × 12.50
    expect(po.items.map((i) => i.unitCost)).toEqual(['4.10', '12.50']);
    expect(po.items.every((i) => i.qtyReceived === 0)).toBe(true);
  });

  it('valida ítems', () => {
    const base = { tenantId: 't', supplierId: 's', warehouseId: 'w', number: 'X', expectedAt: null, createdBy: null };
    expect(() => PurchaseOrder.create({ ...base, items: [] })).toThrow(ValidationError);
    expect(() =>
      PurchaseOrder.create({
        ...base,
        items: [
          { variantId: 'v', qtyOrdered: 1, unitCost: '1' },
          { variantId: 'v', qtyOrdered: 2, unitCost: '1' },
        ],
      }),
    ).toThrow(ValidationError);
    expect(() => PurchaseOrder.create({ ...base, items: [{ variantId: 'v', qtyOrdered: 0, unitCost: '1' }] })).toThrow(
      ValidationError,
    );
    expect(() => PurchaseOrder.create({ ...base, items: [{ variantId: 'v', qtyOrdered: 1, unitCost: '1.999' }] })).toThrow(
      ValidationError,
    );
  });

  it('no se puede recibir en draft', () => {
    const po = draft();
    expect(() => po.receive([{ itemId: po.items[0].id, quantity: 1 }])).toThrow(InvalidPurchaseOrderTransitionError);
  });

  it('recepción parcial y luego total', () => {
    const po = draft();
    po.send();
    const [i1, i2] = po.items;

    const first = po.receive([{ itemId: i1.id, quantity: 4 }]);
    expect(first).toEqual([{ itemId: i1.id, variantId: 'v1', quantity: 4, unitCost: '4.10' }]);
    expect(po.status).toBe('partially_received');

    po.receive([
      { itemId: i1.id, quantity: 6 },
      { itemId: i2.id, quantity: 3 },
    ]);
    expect(po.status).toBe('received');
    expect(po.items.map((i) => i.qtyReceived)).toEqual([10, 3]);
    expect(() => po.receive([{ itemId: i1.id, quantity: 1 }])).toThrow(InvalidPurchaseOrderTransitionError);
  });

  it('no permite recibir más de lo pendiente (ni sumando líneas repetidas) y no cambia nada si falla', () => {
    const po = draft();
    po.send();
    const [i1, i2] = po.items;
    po.receive([{ itemId: i1.id, quantity: 8 }]);

    expect(() => po.receive([{ itemId: i1.id, quantity: 3 }])).toThrow(OverReceiptError);
    expect(() =>
      po.receive([
        { itemId: i2.id, quantity: 1 },
        { itemId: i1.id, quantity: 2 },
        { itemId: i1.id, quantity: 1 },
      ]),
    ).toThrow(OverReceiptError);
    expect(po.items.map((i) => i.qtyReceived)).toEqual([8, 0]);
  });

  it('rechaza ítems ajenos y cantidades inválidas', () => {
    const po = draft();
    po.send();
    expect(() => po.receive([{ itemId: 'otro', quantity: 1 }])).toThrow(ValidationError);
    expect(() => po.receive([{ itemId: po.items[0].id, quantity: 0 }])).toThrow(ValidationError);
    expect(() => po.receive([])).toThrow(ValidationError);
  });

  it('transiciones de envío y cancelación', () => {
    const po = draft();
    po.send();
    expect(() => po.send()).toThrow(InvalidPurchaseOrderTransitionError);
    po.cancel();
    expect(po.status).toBe('cancelled');

    const partial = draft();
    partial.send();
    partial.receive([{ itemId: partial.items[0].id, quantity: 1 }]);
    expect(() => partial.cancel()).toThrow(InvalidPurchaseOrderTransitionError);
  });
});

describe('generatePurchaseOrderNumber', () => {
  it('usa el formato OC-AAAAMMDD-XXXXXX', () => {
    expect(generatePurchaseOrderNumber(new Date('2026-09-28T12:00:00Z'))).toMatch(/^OC-20260928-[0-9A-F]{6}$/);
  });
});
