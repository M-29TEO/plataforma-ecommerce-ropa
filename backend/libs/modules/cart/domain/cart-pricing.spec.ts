import type { SellableVariant } from '../../catalog';
import type { CartItem } from './cart';
import { analyzeLines, isBlocking, priceLines } from './cart-pricing';

const T0 = new Date('2026-09-29T15:00:00Z');

function variant(id: string, overrides: Partial<SellableVariant> = {}): SellableVariant {
  return {
    variantId: id,
    productId: `p-${id}`,
    sku: `SKU-${id}`,
    productName: `Producto ${id}`,
    brandId: null,
    brandName: null,
    categoryId: 'c1',
    categoryPath: 'mujer/blusas',
    colorName: 'Negro',
    sizeCode: 'M',
    price: '10.00',
    compareAtPrice: null,
    taxCode: '4',
    unitCost: null,
    weightG: 300,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    purchasable: true,
    ...overrides,
  };
}

const item = (variantId: string, quantity: number, priceAtAdd: string): CartItem => ({ variantId, quantity, priceAtAdd, addedAt: T0 });

describe('analyzeLines · stock, disponibilidad y precio', () => {
  const variants = new Map([
    ['ok', variant('ok')],
    ['caro', variant('caro', { price: '12.50' })],
    ['barato', variant('barato', { price: '8.00' })],
    ['inactivo', variant('inactivo', { purchasable: false })],
    ['iva-raro', variant('iva-raro', { taxCode: '99' })],
    ['agotado', variant('agotado')],
    ['poco', variant('poco')],
  ]);
  const stock = new Map([
    ['ok', 10],
    ['caro', 10],
    ['barato', 10],
    ['inactivo', 10],
    ['iva-raro', 10],
    ['agotado', 0],
    ['poco', 2],
  ]);
  const lines = analyzeLines(
    [
      item('ok', 1, '10.00'),
      item('caro', 1, '10.00'),
      item('barato', 1, '10.00'),
      item('inactivo', 1, '10.00'),
      item('iva-raro', 1, '10.00'),
      item('borrado', 1, '10.00'),
      item('agotado', 1, '10.00'),
      item('poco', 5, '10.00'),
    ],
    variants,
    stock,
  );
  const byId = Object.fromEntries(lines.map((l) => [l.item.variantId, l]));

  it('línea sin problemas', () => {
    expect(byId.ok).toMatchObject({ billable: true, issues: [], available: 10, unitPriceCents: 1000, rateBp: 1500 });
  });

  it('precio que subió o bajó: aviso, sigue facturable al precio vigente', () => {
    expect(byId.caro.issues).toEqual([
      { code: 'PRICE_CHANGED', message: 'El precio subió de $10.00 a $12.50', previousPrice: '10.00', currentPrice: '12.50', direction: 'up' },
    ]);
    expect(byId.barato.issues[0]).toMatchObject({ code: 'PRICE_CHANGED', direction: 'down', currentPrice: '8.00' });
    expect(byId.caro.billable && byId.barato.billable).toBe(true);
    expect(isBlocking(byId.caro.issues[0])).toBe(false);
  });

  it.each(['inactivo', 'iva-raro', 'borrado'])('%s → UNAVAILABLE, fuera de los totales', (id) => {
    expect(byId[id]).toMatchObject({ billable: false, issues: [expect.objectContaining({ code: 'UNAVAILABLE' })] });
  });

  it('agotado → OUT_OF_STOCK, fuera de los totales', () => {
    expect(byId.agotado).toMatchObject({ billable: false, issues: [{ code: 'OUT_OF_STOCK', message: 'Agotado' }] });
  });

  it('más unidades que el disponible → INSUFFICIENT_STOCK: suma al total pero bloquea el checkout', () => {
    expect(byId.poco).toMatchObject({ billable: true, available: 2 });
    expect(byId.poco.issues).toEqual([{ code: 'INSUFFICIENT_STOCK', message: 'Solo quedan 2 unidades', available: 2 }]);
    expect(isBlocking(byId.poco.issues[0])).toBe(true);
  });
});

describe('priceLines · IVA por tax_code', () => {
  const variants = new Map([
    ['blusa', variant('blusa', { price: '19.90', taxCode: '4' })], // 15 %
    ['libro', variant('libro', { price: '12.00', taxCode: '0' })], // 0 %
    ['jean', variant('jean', { price: '39.99', taxCode: '4' })],
    ['bolso', variant('bolso', { price: '25.00', taxCode: '5' })], // 5 %
    ['agotado', variant('agotado', { price: '99.00' })],
  ]);
  const stock = new Map([
    ['blusa', 10],
    ['libro', 10],
    ['jean', 10],
    ['bolso', 10],
    ['agotado', 0],
  ]);
  const analyzed = analyzeLines(
    [item('blusa', 2, '19.90'), item('libro', 1, '12.00'), item('jean', 1, '39.99'), item('bolso', 1, '25.00'), item('agotado', 1, '99.00')],
    variants,
    stock,
  );

  it('sin descuentos: IVA por línea redondeado y desglose por tarifa', () => {
    const { items, totals, taxes } = priceLines(analyzed, new Map());
    const byId = Object.fromEntries(items.map((i) => [i.variantId, i]));
    // 39.80 × 15 % = 5.97; 12.00 × 0 % = 0; 39.99 × 15 % = 5.9985 → 6.00; 25.00 × 5 % = 1.25
    expect(byId.blusa).toMatchObject({ subtotal: '39.80', discount: '0.00', taxRate: '15.00', taxAmount: '5.97', total: '45.77' });
    expect(byId.libro).toMatchObject({ taxRate: '0.00', taxAmount: '0.00', total: '12.00' });
    expect(byId.jean).toMatchObject({ taxAmount: '6.00', total: '45.99' });
    expect(byId.bolso).toMatchObject({ taxRate: '5.00', taxAmount: '1.25', total: '26.25' });
    expect(byId.agotado).toMatchObject({ billable: false, subtotal: null, total: null, unitPrice: '99.00' });
    expect(totals).toEqual({
      itemCount: 5,
      subtotal: '116.79',
      discountTotal: '0.00',
      taxableBase: '116.79',
      taxTotal: '13.22',
      total: '130.01',
    });
    expect(taxes).toEqual([
      { taxCode: '0', rate: '0.00', base: '12.00', amount: '0.00' },
      { taxCode: '4', rate: '15.00', base: '79.79', amount: '11.97' },
      { taxCode: '5', rate: '5.00', base: '25.00', amount: '1.25' },
    ]);
  });

  it('el descuento reduce la base del IVA de su línea', () => {
    const { items, totals } = priceLines(
      analyzed,
      new Map([
        ['blusa', 398], // 10 % de 39.80
        ['libro', 1200],
      ]),
    );
    const blusa = items.find((i) => i.variantId === 'blusa')!;
    // base 35.82 × 15 % = 5.373 → 5.37
    expect(blusa).toMatchObject({ discount: '3.98', taxAmount: '5.37', total: '41.19' });
    expect(items.find((i) => i.variantId === 'libro')).toMatchObject({ discount: '12.00', total: '0.00' });
    expect(totals).toMatchObject({ discountTotal: '15.98', taxableBase: '100.81', taxTotal: '12.62', total: '113.43' });
  });

  it('un descuento mayor que la línea se limita al valor de la línea', () => {
    const { items } = priceLines(analyzed, new Map([['bolso', 99_999]]));
    expect(items.find((i) => i.variantId === 'bolso')).toMatchObject({ discount: '25.00', taxAmount: '0.00', total: '0.00' });
  });
});
