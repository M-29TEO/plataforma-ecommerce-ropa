import { describe, expect, it } from 'vitest';
import { clearFilters, hasActiveFilters, parseFilters, toApiQuery, toggle, toUrlSearch } from './filters';

describe('filtros del catálogo en la URL', () => {
  it('lee la URL en español con listas por coma o repetidas', () => {
    const f = parseFilters(new URLSearchParams('talla=S,M&talla=M&color=Azul%20marino&marca=costa-azul&genero=mujer&precio=20-60&ofertas=1&orden=precio-asc&pagina=2'));
    expect(f).toEqual({
      sizes: ['S', 'M'],
      colors: ['Azul marino'],
      brands: ['costa-azul'],
      genders: ['mujer'],
      minPrice: 20,
      maxPrice: 60,
      onSale: true,
      sort: 'precio-asc',
      page: 2,
      q: '',
    });
  });

  it('descarta valores inválidos en vez de fallar', () => {
    const f = parseFilters({ marca: 'MAL SLUG', genero: 'marciano', orden: 'barato', pagina: '-3', precio: 'abc-' });
    expect(f.brands).toEqual([]);
    expect(f.genders).toEqual([]);
    expect(f.sort).toBe('novedades');
    expect(f.page).toBe(1);
    expect(f.minPrice).toBeNull();
    expect(hasActiveFilters(f)).toBe(false);
  });

  it('traduce al API: categoría y marca fijas de la página, géneros en inglés, precios con 2 decimales', () => {
    const f = parseFilters(new URLSearchParams('talla=M&marca=nan&genero=hombre&precio=-45'));
    const q = toApiQuery(f, { category: 'hombre/jeans', brand: 'volcan-denim' });
    expect(Object.fromEntries(q)).toEqual({
      category: 'hombre/jeans',
      brand: 'volcan-denim,nan',
      size: 'M',
      gender: 'men',
      maxPrice: '45.00',
      sort: 'newest',
      page: '1',
      pageSize: '24',
    });
  });

  it('relevancia solo tiene sentido con búsqueda', () => {
    expect(toApiQuery(parseFilters({ orden: 'relevancia' })).get('sort')).toBe('newest');
    expect(toApiQuery(parseFilters({ orden: 'relevancia', q: 'jean' })).get('sort')).toBe('relevance');
  });

  it('URL de vuelta: solo lo distinto del valor por defecto; ida y vuelta estable', () => {
    const f = parseFilters(new URLSearchParams('color=Negro&orden=novedades&pagina=1'));
    expect(toUrlSearch(f)).toBe('?color=Negro');
    const round = parseFilters(new URLSearchParams(toUrlSearch(toggle(f, 'sizes', 'L')).slice(1)));
    expect(round.sizes).toEqual(['L']);
    expect(round.colors).toEqual(['Negro']);
  });

  it('cambiar un filtro vuelve a la página 1; limpiar conserva orden y búsqueda', () => {
    const f = parseFilters({ talla: 'S', pagina: '3', orden: 'precio-desc', q: 'lino' });
    expect(toggle(f, 'sizes', 'S')).toMatchObject({ sizes: [], page: 1 });
    expect(clearFilters(f)).toMatchObject({ sizes: [], page: 1, sort: 'precio-desc', q: 'lino' });
  });
});
