import { assertCompareAtAbovePrice, assertVariantsKeepDiscount, effectivePrice, variantsWithFalseDiscount, InvalidPriceError, nextFreeSlug, normalizeMoney, SLUG_MAX_LENGTH, SLUG_RE, slugify } from './admin-catalog';

describe('Administración del catálogo: reglas puras', () => {
  describe('slugify', () => {
    it('quita tildes y eñes, pasa a minúsculas y une con guiones', () => {
      expect(slugify('Vestido Floral Año 2026!')).toBe('vestido-floral-ano-2026');
      expect(slugify('  Camisa   de   Lino  ')).toBe('camisa-de-lino');
      expect(slugify('Pantalón "Cargo" — Niños')).toBe('pantalon-cargo-ninos');
    });

    it('si no queda nada usa "producto" y siempre cumple el formato', () => {
      expect(slugify('¡¡¡ ??? !!!')).toBe('producto');
      for (const name of ['Ñandú', 'Árbol--de--Navidad', 'Zapato 42/43']) expect(slugify(name)).toMatch(SLUG_RE);
    });

    it('recorta a la longitud máxima sin dejar un guion al final', () => {
      const slug = slugify(`${'a'.repeat(SLUG_MAX_LENGTH - 1)} bcd`);
      expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
      expect(slug.endsWith('-')).toBe(false);
    });
  });

  describe('nextFreeSlug', () => {
    it('devuelve la base si está libre y si no el primer sufijo libre', () => {
      expect(nextFreeSlug('blusa', [])).toBe('blusa');
      expect(nextFreeSlug('blusa', ['blusa'])).toBe('blusa-2');
      expect(nextFreeSlug('blusa', ['blusa', 'blusa-2', 'blusa-3'])).toBe('blusa-4');
      expect(nextFreeSlug('blusa', ['blusa', 'blusa-3'])).toBe('blusa-2');
    });
  });

  describe('precios', () => {
    it('normaliza montos a dos decimales y rechaza los inválidos', () => {
      expect(normalizeMoney('12.5')).toBe('12.50');
      expect(normalizeMoney(19.9)).toBe('19.90');
      expect(normalizeMoney('7')).toBe('7.00');
      expect(normalizeMoney(null)).toBeNull();
      expect(normalizeMoney(undefined)).toBeUndefined();
      expect(() => normalizeMoney('1.999')).toThrow('Monto inválido');
      expect(() => normalizeMoney('-1')).toThrow('Monto inválido');
    });

    it('el precio tachado debe ser mayor que el de venta', () => {
      expect(() => assertCompareAtAbovePrice('20.00', '25.00')).not.toThrow();
      expect(() => assertCompareAtAbovePrice('20.00', null)).not.toThrow();
      expect(() => assertCompareAtAbovePrice('20.00', '20.00')).toThrow(InvalidPriceError);
      expect(() => assertCompareAtAbovePrice('20.00', '19.99')).toThrow(InvalidPriceError);
      try {
        assertCompareAtAbovePrice('9.00', '8.00', 'variants[x].compareAtPrice');
      } catch (e) {
        expect((e as InvalidPriceError).code).toBe('INVALID_PRICE');
        expect((e as InvalidPriceError).details).toMatchObject({ field: 'variants[x].compareAtPrice' });
      }
    });

    it('detecta variantes herederas que quedarían con rebaja falsa al subir el precio base', () => {
      const variants = [
        { id: 'hereda-ok', price: null, compareAtPrice: '60.00' },
        { id: 'hereda-mal', price: null, compareAtPrice: '50.00' },
        { id: 'propio', price: '40.00', compareAtPrice: '45.00' },
        { id: 'sin-tachado', price: null, compareAtPrice: null },
      ];
      expect(variantsWithFalseDiscount('49.99', variants)).toEqual([]);
      expect(variantsWithFalseDiscount('50.00', variants)).toEqual(['hereda-mal']);
      expect(variantsWithFalseDiscount('55.00', variants)).toEqual(['hereda-mal']);
      try {
        assertVariantsKeepDiscount('p1', '55.00', variants);
        throw new Error('debió fallar');
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidPriceError);
        expect((e as InvalidPriceError).details).toEqual({ productId: 'p1', basePrice: '55.00', variantIds: ['hereda-mal'] });
      }
      expect(() => assertVariantsKeepDiscount('p1', '45.00', variants)).not.toThrow();
    });

    it('el precio efectivo de una variante es el suyo o el del producto', () => {
      expect(effectivePrice(null, '30.00')).toBe('30.00');
      expect(effectivePrice('27.50', '30.00')).toBe('27.50');
    });
  });
});
