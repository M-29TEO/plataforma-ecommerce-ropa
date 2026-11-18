import { categoryAncestors, effectiveSort, escapeLike, mediaUrl, normalizeSearch, parseList, stockLevel } from './storefront';

describe('Catálogo público: reglas puras', () => {
  it('nivel de stock sin publicar la cantidad exacta', () => {
    expect(stockLevel(0)).toBe('out_of_stock');
    expect(stockLevel(-2)).toBe('out_of_stock');
    expect(stockLevel(1)).toBe('low');
    expect(stockLevel(3)).toBe('low');
    expect(stockLevel(4)).toBe('in_stock');
  });

  it('URL de medios: clave relativa bajo la base, URL absoluta tal cual', () => {
    expect(mediaUrl('/media/', '/products/a/1.jpg')).toBe('/media/products/a/1.jpg');
    expect(mediaUrl('http://cdn.local/m', 'demo/x.svg')).toBe('http://cdn.local/m/demo/x.svg');
    expect(mediaUrl('/media', 'https://ejemplo.ec/foto.jpg')).toBe('https://ejemplo.ec/foto.jpg');
  });

  it('ancestros de una categoría, de la raíz a la hoja', () => {
    expect(categoryAncestors('mujer/vestidos/casual')).toEqual(['mujer', 'mujer/vestidos', 'mujer/vestidos/casual']);
    expect(categoryAncestors('hombre')).toEqual(['hombre']);
  });

  it('texto de búsqueda normalizado', () => {
    expect(normalizeSearch('  vestido\t\nrojo  ')).toBe('vestido rojo');
    expect(normalizeSearch('   ')).toBeUndefined();
    expect(normalizeSearch(undefined)).toBeUndefined();
    expect(normalizeSearch('x'.repeat(300))).toHaveLength(100);
  });

  it('escapa comodines de LIKE', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('listas de filtros: coma o repetidos, sin vacíos ni duplicados, acotadas', () => {
    expect(parseList('S, M,,M')).toEqual(['S', 'M']);
    expect(parseList(['negro', 'azul,negro'])).toEqual(['negro', 'azul']);
    expect(parseList(undefined)).toEqual([]);
    expect(parseList(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(20);
  });

  it('sin búsqueda la relevancia cae a novedades', () => {
    expect(effectiveSort('relevance', undefined)).toBe('newest');
    expect(effectiveSort('relevance', 'jean')).toBe('relevance');
    expect(effectiveSort('price_asc', undefined)).toBe('price_asc');
  });
});
