import { describe, expect, it } from 'vitest';
import type { ProductDetail } from './types';
import { findVariant, fitAdvice, imagesForColor, initialColor, sizeAvailability } from './variants';

const v = (color: string, size: string, stock: 'in_stock' | 'low' | 'out_of_stock') => ({
  id: `${color}-${size}`,
  sku: `${color}-${size}`,
  color: { name: color, hex: null },
  size,
  price: '10.00',
  compareAtPrice: null,
  stock,
});

const product = {
  colors: [
    { name: 'Rojo', hex: null },
    { name: 'Negro', hex: null },
  ],
  sizes: ['S', 'M', 'L'],
  variants: [v('Rojo', 'S', 'out_of_stock'), v('Rojo', 'M', 'out_of_stock'), v('Negro', 'M', 'low'), v('Negro', 'L', 'in_stock')],
} as unknown as ProductDetail;

describe('variantes de la ficha', () => {
  it('color inicial: el primero con stock', () => {
    expect(initialColor(product)).toBe('Negro');
  });

  it('tallas por color: las que no existen en ese color quedan en null', () => {
    expect(sizeAvailability(product, 'Negro')).toEqual([
      { size: 'S', stock: null },
      { size: 'M', stock: 'low' },
      { size: 'L', stock: 'in_stock' },
    ]);
    expect(findVariant(product, 'Rojo', 'L')).toBeUndefined();
    expect(findVariant(product, 'Negro', 'L')?.id).toBe('Negro-L');
  });

  it('fotos del color elegido más las comunes', () => {
    const media = [
      { url: 'a', colorName: null },
      { url: 'b', colorName: 'Rojo' },
      { url: 'c', colorName: 'Negro' },
    ] as ProductDetail['media'];
    expect(imagesForColor(media, 'Rojo').map((m) => m.url)).toEqual(['a', 'b']);
    expect(imagesForColor(media, 'Azul').map((m) => m.url)).toEqual(['a']);
    expect(imagesForColor(media, null)).toHaveLength(3);
  });

  it('consejo de talla con al menos 3 opiniones', () => {
    expect(fitAdvice({ small: 1, true: 1, large: 0 })).toBeNull();
    expect(fitAdvice({ small: 6, true: 3, large: 1 })).toMatch(/60 % dice que queda pequeño/);
    expect(fitAdvice({ small: 1, true: 8, large: 1 })).toMatch(/80 % dice que la talla es la correcta/);
  });
});
