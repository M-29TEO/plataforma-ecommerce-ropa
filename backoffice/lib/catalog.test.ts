import { describe, expect, it } from 'vitest';
import {
  applyPercent,
  applyPriceTool,
  buildPriceBatches,
  categoryOptions,
  centsToMoney,
  createProductBody,
  createVariantBody,
  draftError,
  EMPTY_PRODUCT_FORM,
  inheritedPriceConflict,
  reorderMedia,
  isFormDirty,
  marginRatio,
  mergeAfterReload,
  missingCombinations,
  moneyError,
  moneyToCents,
  normalizeMoney,
  parseMoney,
  type PriceDraft,
  type ProductFormValues,
  type ProductPriceDraft,
  slugError,
  slugify,
  sortSizes,
  suggestSku,
  updateProductBody,
  updateVariantBody,
  validateProductForm,
  validateProductPrices,
  validateVariantForm,
  type VariantFormValues,
} from './catalog';

describe('montos', () => {
  it('parseMoney normaliza a 2 decimales y acepta coma', () => {
    expect(parseMoney('12')).toBe('12.00');
    expect(parseMoney('12.5')).toBe('12.50');
    expect(parseMoney(' 19,9 ')).toBe('19.90');
    expect(parseMoney('0')).toBe('0.00');
  });

  it('parseMoney rechaza negativos, 3 decimales, letras y vacío', () => {
    for (const bad of ['-1', '1.234', 'abc', '', '1.', '.5', '1e3']) expect(parseMoney(bad)).toBeNull();
  });

  it('centavos ida y vuelta sin errores de coma flotante', () => {
    expect(moneyToCents('19.99')).toBe(1999);
    expect(moneyToCents(0.1 + 0.2)).toBe(30);
    expect(moneyToCents('7.5')).toBe(750);
    expect(centsToMoney(5)).toBe('0.05');
    expect(centsToMoney(-10)).toBe('0.00');
    expect(normalizeMoney(12.5)).toBe('12.50');
    expect(normalizeMoney(null)).toBeNull();
  });

  it('moneyError: obligatorio y formato', () => {
    expect(moneyError('', true)).toBe('Obligatorio');
    expect(moneyError('')).toBeNull();
    expect(moneyError('1.999')).not.toBeNull();
    expect(moneyError('10.90')).toBeNull();
  });

  it('margen = (base − costo) / base', () => {
    expect(marginRatio('100', '60')).toBeCloseTo(0.4);
    expect(marginRatio('20', '25')).toBeCloseTo(-0.25);
    expect(marginRatio('0', '5')).toBeNull();
    expect(marginRatio('20', '')).toBeNull();
  });

  it('el tachado debe ser mayor que el precio base', () => {
    expect(validateProductPrices({ basePrice: '20', compareAtPrice: '20', cost: '' }).compareAtPrice).toMatch(/mayor/);
    expect(validateProductPrices({ basePrice: '20', compareAtPrice: '25', cost: '10' })).toEqual({});
    expect(validateProductPrices({ basePrice: '', compareAtPrice: '', cost: 'x' })).toMatchObject({ basePrice: 'Obligatorio', cost: expect.any(String) });
  });
});

describe('conflicto de variantes que heredan', () => {
  it('lee details.variantIds del 422 INVALID_PRICE', () => {
    expect(inheritedPriceConflict({ productId: 'p', basePrice: '30.00', variantIds: ['v1', 'v2'] })).toEqual({ productId: 'p', basePrice: '30.00', variantIds: ['v1', 'v2'] });
    expect(inheritedPriceConflict({ field: 'compareAtPrice' })).toBeNull();
    expect(inheritedPriceConflict({ variantIds: [] })).toBeNull();
    expect(inheritedPriceConflict(undefined)).toBeNull();
  });
});

describe('orden de fotos', () => {
  const media = [
    { id: 'a', sortOrder: 0 },
    { id: 'b', sortOrder: 1 },
    { id: 'c', sortOrder: 2 },
  ];
  it('sube y baja intercambiando con la vecina', () => {
    expect(reorderMedia(media, 'b', -1)).toEqual([
      { id: 'b', sortOrder: 0 },
      { id: 'a', sortOrder: 1 },
    ]);
    expect(reorderMedia(media, 'b', 1)).toEqual([
      { id: 'c', sortOrder: 1 },
      { id: 'b', sortOrder: 2 },
    ]);
    expect(reorderMedia(media, 'a', -1)).toEqual([]);
    expect(reorderMedia(media, 'c', 1)).toEqual([]);
  });
  it('renumera órdenes repetidos', () => {
    expect(reorderMedia([{ id: 'a', sortOrder: 5 }, { id: 'b', sortOrder: 5 }], 'b', -1)).toEqual([
      { id: 'b', sortOrder: 0 },
      { id: 'a', sortOrder: 1 },
    ]);
  });
});

describe('slug y SKU', () => {
  it('slugify quita tildes, eñes y símbolos', () => {
    expect(slugify('Vestido Floral Año 2026!')).toBe('vestido-floral-ano-2026');
    expect(slugify('  --Camisa  Lino--  ')).toBe('camisa-lino');
    expect(slugError('vestido-floral')).toBeNull();
    expect(slugError('Vestido Floral')).not.toBeNull();
  });

  it('suggestSku arma SLUG-COLOR-TALLA en mayúsculas sin tildes', () => {
    expect(suggestSku('vestido-floral', 'Azul Marino', 'M')).toBe('VESTIDO-FLORAL-AZUL-MARINO-M');
    expect(suggestSku('camisa', 'Café', '10½')).toBe('CAMISA-CAFE-10');
    expect(suggestSku('jean-niño', null, '28')).toBe('JEAN-NINO-28');
    expect(suggestSku('x'.repeat(80), 'rojo', 'S').length).toBeLessThanOrEqual(64);
  });
});

describe('lookups', () => {
  it('categoryOptions muestra la ruta con nombres', () => {
    const opts = categoryOptions([
      { id: 'b', parentId: 'a', name: 'Vestidos', slug: 'vestidos', path: 'mujer/vestidos', active: true },
      { id: 'a', parentId: null, name: 'Mujer', slug: 'mujer', path: 'mujer', active: true },
    ]);
    expect(opts.map((o) => o.label)).toEqual(['Mujer', 'Mujer › Vestidos']);
  });

  it('sortSizes respeta sistema y orden', () => {
    const s = sortSizes([
      { id: '3', code: '30', sizeSystem: 'numeric', sortOrder: 2 },
      { id: '2', code: 'M', sizeSystem: 'alpha', sortOrder: 2 },
      { id: '1', code: 'S', sizeSystem: 'alpha', sortOrder: 1 },
    ]);
    expect(s.map((x) => x.code)).toEqual(['S', 'M', '30']);
  });
});

describe('matriz de variantes', () => {
  const colors = [
    { id: 'c1', name: 'Rojo', hex: '#ff0000' },
    { id: 'c2', name: 'Azul', hex: null },
  ];
  const sizes = [
    { id: 's1', code: 'S', sizeSystem: 'alpha' as const, sortOrder: 1 },
    { id: 's2', code: 'M', sizeSystem: 'alpha' as const, sortOrder: 2 },
  ];

  it('solo crea las combinaciones que faltan', () => {
    const existing = [{ sku: 'VESTIDO-ROJO-S', color: { id: 'c1', name: 'Rojo', hex: null }, size: { id: 's1', code: 'S' } }];
    const combos = missingCombinations('vestido', existing, colors, sizes);
    expect(combos).toEqual([
      { colorId: 'c1', sizeId: 's2', sku: 'VESTIDO-ROJO-M' },
      { colorId: 'c2', sizeId: 's1', sku: 'VESTIDO-AZUL-S' },
      { colorId: 'c2', sizeId: 's2', sku: 'VESTIDO-AZUL-M' },
    ]);
  });

  it('evita SKU repetidos con sufijo', () => {
    const existing = [{ sku: 'vestido-rojo-s', color: null, size: null }];
    expect(missingCombinations('vestido', existing, [colors[0]], [sizes[0]])[0].sku).toBe('VESTIDO-ROJO-S-2');
  });
});

describe('formulario de producto', () => {
  const base: ProductFormValues = {
    ...EMPTY_PRODUCT_FORM,
    name: 'Vestido',
    slug: 'vestido',
    categoryId: 'cat',
    gender: 'women',
    basePrice: '20.00',
    material: 'Lino',
  };

  it('valida obligatorios', () => {
    const e = validateProductForm(EMPTY_PRODUCT_FORM);
    expect(Object.keys(e).sort()).toEqual(['basePrice', 'categoryId', 'gender', 'name']);
    expect(validateProductForm(base)).toEqual({});
  });

  it('createProductBody omite vacíos y normaliza montos', () => {
    expect(createProductBody({ ...base, slug: '', basePrice: '19,9', cost: '8' })).toEqual({
      name: 'Vestido',
      categoryId: 'cat',
      gender: 'women',
      material: 'Lino',
      basePrice: '19.90',
      cost: '8.00',
      taxCode: '4',
      status: 'draft',
    });
  });

  it('updateProductBody manda solo lo cambiado y null para limpiar', () => {
    const cur = { ...base, material: '', basePrice: '25', status: 'active' as const };
    expect(updateProductBody(base, cur, '2026-01-01T00:00:00.000Z')).toEqual({
      material: null,
      basePrice: '25.00',
      status: 'active',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(isFormDirty(base, { ...base, basePrice: '20' })).toBe(false);
  });

  it('mergeAfterReload conserva lo tecleado y toma lo nuevo del servidor', () => {
    const current = { ...base, name: 'Vestido largo' };
    const server = { ...base, material: 'Algodón', name: 'Vestido (otro)' };
    const merged = mergeAfterReload(base, server, current);
    expect(merged.name).toBe('Vestido largo');
    expect(merged.material).toBe('Algodón');
  });
});

describe('variantes', () => {
  const v: VariantFormValues = { sku: 'V-1', barcode: '', colorId: 'c', sizeId: '', price: '', compareAtPrice: '', weightG: '300', status: 'active' };

  it('el tachado se compara con el precio heredado si no tiene propio', () => {
    expect(validateVariantForm({ ...v, compareAtPrice: '20' }, '20.00').compareAtPrice).toMatch(/mayor/);
    expect(validateVariantForm({ ...v, compareAtPrice: '25' }, '20.00')).toEqual({});
    expect(validateVariantForm({ ...v, price: '30', compareAtPrice: '25' }, '20.00').compareAtPrice).toMatch(/mayor/);
    expect(validateVariantForm({ ...v, sku: 'con espacio', barcode: 'ab', weightG: '0' }, '1')).toMatchObject({
      sku: expect.any(String),
      barcode: expect.any(String),
      weightG: expect.any(String),
    });
  });

  it('cuerpos de alta y edición', () => {
    expect(createVariantBody({ ...v, price: '9.9' })).toEqual({ sku: 'V-1', colorId: 'c', price: '9.90', weightG: 300, status: 'active' });
    expect(updateVariantBody({ ...v, price: '9.90' }, { ...v, price: '', barcode: '7861234' })).toEqual({ barcode: '7861234', price: null });
  });
});

describe('precios masivos', () => {
  it('applyPercent redondea al centavo', () => {
    expect(applyPercent(1999, 10)).toBe(2199); // 21.989 → 21.99
    expect(applyPercent(1000, -15)).toBe(850);
    expect(applyPercent(333, 33.333)).toBe(444);
  });

  it('herramientas', () => {
    const p = { price: '20.00', compareAtPrice: null };
    expect(applyPriceTool(p, { kind: 'set', value: '18' })).toEqual({ price: '18.00', compareAtPrice: null });
    expect(applyPriceTool(p, { kind: 'percent', percent: 10 })).toEqual({ price: '22.00', compareAtPrice: null });
    expect(applyPriceTool(p, { kind: 'percent', percent: -10 })).toEqual({ price: '18.00', compareAtPrice: null });
    expect(applyPriceTool(p, { kind: 'discount', percent: 20 })).toEqual({ price: '16.00', compareAtPrice: '20.00' });
    // Una segunda rebaja conserva el tachado original.
    expect(applyPriceTool({ price: '16.00', compareAtPrice: '20.00' }, { kind: 'discount', percent: 10 })).toEqual({ price: '14.40', compareAtPrice: '20.00' });
    expect(applyPriceTool({ price: '16.00', compareAtPrice: '20.00' }, { kind: 'clearCompareAt' })).toEqual({ price: '16.00', compareAtPrice: null });
    expect(applyPriceTool(p, { kind: 'setCompareAt', value: '30' })).toEqual({ price: '20.00', compareAtPrice: '30.00' });
    // Variante que hereda: el % se calcula sobre el precio del producto y le fija precio propio.
    expect(applyPriceTool({ price: null, compareAtPrice: null }, { kind: 'percent', percent: 50 }, '10.00')).toEqual({ price: '15.00', compareAtPrice: null });
    expect(applyPriceTool({ price: null, compareAtPrice: null }, { kind: 'setCompareAt', value: '12' }, '10.00')).toEqual({ price: null, compareAtPrice: '12.00' });
  });

  const product = (id: string, before: string, after: string, cmp: string | null = null): ProductPriceDraft => ({
    kind: 'product',
    id,
    label: id,
    before: { price: before, compareAtPrice: null },
    after: { price: after, compareAtPrice: cmp },
  });

  it('draftError valida el tachado de la variante contra el precio nuevo del producto', () => {
    const p = product('p1', '20.00', '30.00');
    const v: PriceDraft = {
      kind: 'variant',
      id: 'v1',
      productId: 'p1',
      label: 'v1',
      productBasePrice: '20.00',
      before: { price: null, compareAtPrice: null },
      after: { price: null, compareAtPrice: '25.00' },
    };
    expect(draftError(v, new Map())).toBeNull();
    expect(draftError(v, new Map([['p1', p]]))).toMatch(/mayor/);
    expect(draftError(product('p2', '1', '5', '4.00'), new Map())).toMatch(/mayor/);
  });

  it('buildPriceBatches manda solo lo cambiado y respeta el máximo, con el producto junto a sus variantes', () => {
    const drafts: PriceDraft[] = [
      product('p1', '10.00', '10.00'), // sin cambios: no viaja
      product('p2', '10.00', '12.00'),
      { kind: 'variant', id: 'v1', productId: 'p2', label: '', productBasePrice: '10.00', before: { price: null, compareAtPrice: null }, after: { price: '11.00', compareAtPrice: null } },
      { kind: 'variant', id: 'v2', productId: 'p3', label: '', productBasePrice: '10.00', before: { price: '9.00', compareAtPrice: '15.00' }, after: { price: '9.00', compareAtPrice: null } },
    ];
    const batches = buildPriceBatches(drafts, 2);
    expect(batches).toHaveLength(2);
    expect(batches[0].body).toEqual({ products: [{ id: 'p2', basePrice: '12.00' }], variants: [{ id: 'v1', price: '11.00' }] });
    expect(batches[1].body).toEqual({ products: [], variants: [{ id: 'v2', compareAtPrice: null }] });
    expect(batches[1].ids).toEqual(['v2']);
  });

  it('buildPriceBatches parte un grupo más grande que el máximo', () => {
    const drafts: PriceDraft[] = Array.from({ length: 5 }, (_, i) => product(`p${i}`, '1.00', '2.00'));
    expect(buildPriceBatches(drafts, 2).map((b) => b.ids.length)).toEqual([2, 2, 1]);
    expect(buildPriceBatches([], 2)).toEqual([]);
  });
});
