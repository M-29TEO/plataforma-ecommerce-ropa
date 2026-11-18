import { InvalidPromotionError } from './errors';
import { customerKeysFor, isValidCouponCode, normalizeCouponCode, validatePromotionDefinition, validatePromotionWindow } from './promotion';

describe('validatePromotionDefinition', () => {
  it('normaliza montos, categorías y listas', () => {
    expect(
      validatePromotionDefinition({
        type: 'percent',
        conditions: { minSubtotal: 50, categoryPaths: ['/Mujer/Vestidos/', 'mujer/vestidos'], productIds: ['p1', 'p1', ' p2 '] },
        benefit: { percent: 12.5, maxDiscount: '20' },
      }),
    ).toEqual({
      type: 'percent',
      conditions: { minSubtotal: '50.00', categoryPaths: ['mujer/vestidos'], productIds: ['p1', 'p2'] },
      benefit: { percent: 12.5, maxDiscount: '20.00' },
    });
  });

  it('2x1 toma percentOff 100 por defecto', () => {
    expect(validatePromotionDefinition({ type: 'buy_x_get_y', benefit: { buyQuantity: 1, getQuantity: 1 } }).benefit).toEqual({
      buyQuantity: 1,
      getQuantity: 1,
      percentOff: 100,
    });
  });

  it('envío gratis sin benefit explícito', () => {
    expect(validatePromotionDefinition({ type: 'free_shipping', conditions: { minSubtotal: '60' }, benefit: {} })).toMatchObject({
      conditions: { minSubtotal: '60.00' },
      benefit: {},
    });
  });

  it('ordena los tramos por mínimo', () => {
    const { benefit } = validatePromotionDefinition({
      type: 'tiered',
      benefit: { basis: 'subtotal', tiers: [{ min: '100', percent: 10 }, { min: '50', amount: '3' }] },
    });
    expect(benefit).toEqual({ basis: 'subtotal', tiers: [{ min: '50.00', amount: '3.00' }, { min: '100.00', percent: 10 }] });
  });

  it.each<[string, { type: string; conditions?: unknown; benefit: unknown }, RegExp]>([
    ['tipo gift (no implementado)', { type: 'gift', benefit: {} }, /no soportado/],
    ['campo desconocido en benefit', { type: 'percent', benefit: { percent: 10, extra: 1 } }, /desconocidos: extra/],
    ['campo desconocido en conditions', { type: 'fixed', conditions: { minTotal: 5 }, benefit: { amount: '1' } }, /desconocidos/],
    ['porcentaje > 100', { type: 'percent', benefit: { percent: 101 } }, /hasta 100/],
    ['porcentaje 0', { type: 'percent', benefit: { percent: 0 } }, /mayor que 0/],
    ['porcentaje con 3 decimales', { type: 'percent', benefit: { percent: 10.125 } }, /2 decimales/],
    ['porcentaje como texto', { type: 'percent', benefit: { percent: '10' } }, /porcentaje/],
    ['monto fijo 0', { type: 'fixed', benefit: { amount: '0' } }, /mayor que 0/],
    ['monto con 3 decimales', { type: 'fixed', benefit: { amount: '1.999' } }, /2 decimales/],
    ['2x1 sin getQuantity', { type: 'buy_x_get_y', benefit: { buyQuantity: 1 } }, /getQuantity/],
    ['tiered sin tramos', { type: 'tiered', benefit: { basis: 'subtotal', tiers: [] } }, /de 1 a 20 tramos/],
    ['tiered con basis inválido', { type: 'tiered', benefit: { basis: 'peso', tiers: [{ min: 1, percent: 5 }] } }, /basis/],
    [
      'tramo con percent y amount',
      { type: 'tiered', benefit: { basis: 'quantity', tiers: [{ min: 2, percent: 5, amount: '1' }] } },
      /solo uno/,
    ],
    [
      'tramos con el mismo mínimo',
      { type: 'tiered', benefit: { basis: 'quantity', tiers: [{ min: 2, percent: 5 }, { min: 2, percent: 10 }] } },
      /mismo mínimo/,
    ],
    ['lista vacía de productos', { type: 'percent', conditions: { productIds: [] }, benefit: { percent: 5 } }, /lista/],
    ['benefit no es objeto', { type: 'percent', benefit: [10] }, /objeto/],
  ])('rechaza %s', (_name, input, message) => {
    expect(() => validatePromotionDefinition(input)).toThrow(InvalidPromotionError);
    expect(() => validatePromotionDefinition(input)).toThrow(message);
  });
});

describe('ventana de vigencia', () => {
  it('endsAt debe ser posterior a startsAt', () => {
    const start = new Date('2026-10-01T00:00:00Z');
    expect(() => validatePromotionWindow(start, null)).not.toThrow();
    expect(() => validatePromotionWindow(start, start)).toThrow(/posterior/);
  });
});

describe('cupones y claves de cliente', () => {
  it('códigos sin distinción de mayúsculas', () => {
    expect(normalizeCouponCode('  bienvenida10 ')).toBe('BIENVENIDA10');
    expect(isValidCouponCode('cyber-2026')).toBe(true);
    expect(isValidCouponCode('ab')).toBe(false);
    expect(isValidCouponCode('con espacio')).toBe(false);
  });

  it('la clave principal es el usuario; el email también cuenta', () => {
    expect(customerKeysFor('u1', ' Maria@Example.TEST ')).toEqual(['user:u1', 'email:maria@example.test']);
    expect(customerKeysFor(null, 'a@b.ec')).toEqual(['email:a@b.ec']);
    expect(customerKeysFor(null, null)).toEqual([]);
  });
});
