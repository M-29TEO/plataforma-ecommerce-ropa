import { describe, expect, it } from 'vitest';
import { safeRedirect } from './safe-redirect';

describe('redirección segura tras el login', () => {
  it('acepta rutas internas', () => {
    expect(safeRedirect('/checkout')).toBe('/checkout');
    expect(safeRedirect('/producto/x?talla=M')).toBe('/producto/x?talla=M');
  });
  it('rechaza dominios externos y valores vacíos', () => {
    expect(safeRedirect('https://malo.com')).toBe('/mi-cuenta');
    expect(safeRedirect('//malo.com')).toBe('/mi-cuenta');
    expect(safeRedirect('/\\malo.com')).toBe('/mi-cuenta');
    expect(safeRedirect(null, '/')).toBe('/');
  });
});
