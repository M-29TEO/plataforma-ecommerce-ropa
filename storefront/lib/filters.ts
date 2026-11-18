/**
 * Filtros del catálogo en la URL de la tienda (en español, para SEO y para compartir enlaces) y
 * su traducción a los parámetros del API (/v1/catalog/products, en inglés).
 *
 *   /categoria/mujer/vestidos?talla=S,M&color=Negro&marca=costa-azul&precio=20-60&orden=precio-asc&pagina=2
 */

export type SortKey = 'relevancia' | 'novedades' | 'precio-asc' | 'precio-desc' | 'valoracion';

export const SORTS: ReadonlyArray<{ key: SortKey; label: string; api: string }> = [
  { key: 'relevancia', label: 'Más relevantes', api: 'relevance' },
  { key: 'novedades', label: 'Novedades', api: 'newest' },
  { key: 'precio-asc', label: 'Precio: menor a mayor', api: 'price_asc' },
  { key: 'precio-desc', label: 'Precio: mayor a menor', api: 'price_desc' },
  { key: 'valoracion', label: 'Mejor valorados', api: 'rating' },
];

export const GENDERS: ReadonlyArray<{ key: string; api: string; label: string }> = [
  { key: 'mujer', api: 'women', label: 'Mujer' },
  { key: 'hombre', api: 'men', label: 'Hombre' },
  { key: 'unisex', api: 'unisex', label: 'Unisex' },
  { key: 'ninas', api: 'girls', label: 'Niñas' },
  { key: 'ninos', api: 'boys', label: 'Niños' },
  { key: 'bebe', api: 'baby', label: 'Bebé' },
];

export interface Filters {
  sizes: string[];
  colors: string[];
  brands: string[];
  genders: string[];
  minPrice: number | null;
  maxPrice: number | null;
  onSale: boolean;
  sort: SortKey;
  page: number;
  q: string;
}

export const PAGE_SIZE = 24;

/** Claves de la URL que son filtros (cambiarlos vuelve a la página 1 y quita la URL canónica). */
export const FILTER_KEYS = ['talla', 'color', 'marca', 'genero', 'precio', 'ofertas'] as const;

type SearchParams = Record<string, string | string[] | undefined> | URLSearchParams;

function get(sp: SearchParams, key: string): string[] {
  const raw = sp instanceof URLSearchParams ? sp.getAll(key) : sp[key];
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

const unique = (values: string[], max = 20) => [...new Set(values)].slice(0, max);

function price(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

export function parseFilters(sp: SearchParams, defaultSort: SortKey = 'novedades'): Filters {
  const [range] = get(sp, 'precio');
  const [min, max] = range ? range.split('-') : [];
  const sortRaw = get(sp, 'orden')[0];
  const pageRaw = Number(get(sp, 'pagina')[0] ?? '1');
  const genders = get(sp, 'genero').filter((g) => GENDERS.some((x) => x.key === g));
  return {
    sizes: unique(get(sp, 'talla')),
    colors: unique(get(sp, 'color')),
    brands: unique(get(sp, 'marca').filter((b) => /^[a-z0-9-]{1,120}$/.test(b))),
    genders: unique(genders),
    minPrice: price(min),
    maxPrice: price(max),
    onSale: get(sp, 'ofertas')[0] === '1',
    sort: SORTS.some((s) => s.key === sortRaw) ? (sortRaw as SortKey) : defaultSort,
    page: Number.isInteger(pageRaw) && pageRaw >= 1 && pageRaw <= 500 ? pageRaw : 1,
    q: (get(sp, 'q').join(' ') || '').slice(0, 100),
  };
}

export function hasActiveFilters(f: Filters): boolean {
  return f.sizes.length + f.colors.length + f.brands.length + f.genders.length > 0 || f.minPrice !== null || f.maxPrice !== null || f.onSale;
}

/** Parámetros del API para el listado. `base` agrega lo fijo de la página (categoría, marca, colección). */
export function toApiQuery(f: Filters, base: { category?: string; brand?: string; collection?: string } = {}): URLSearchParams {
  const q = new URLSearchParams();
  if (base.category) q.set('category', base.category);
  if (base.collection) q.set('collection', base.collection);
  const brands = unique([...(base.brand ? [base.brand] : []), ...f.brands]);
  if (brands.length) q.set('brand', brands.join(','));
  if (f.sizes.length) q.set('size', f.sizes.join(','));
  // El API separa los valores por coma: un color con coma en el nombre no existe en el catálogo.
  if (f.colors.length) q.set('color', f.colors.join(','));
  if (f.genders.length) q.set('gender', f.genders.map((g) => GENDERS.find((x) => x.key === g)!.api).join(','));
  if (f.minPrice !== null) q.set('minPrice', f.minPrice.toFixed(2));
  if (f.maxPrice !== null) q.set('maxPrice', f.maxPrice.toFixed(2));
  if (f.onSale) q.set('onSale', 'true');
  if (f.q) q.set('q', f.q);
  const sort = f.sort === 'relevancia' && !f.q ? 'novedades' : f.sort;
  q.set('sort', SORTS.find((s) => s.key === sort)!.api);
  q.set('page', String(f.page));
  q.set('pageSize', String(PAGE_SIZE));
  return q;
}

/** URL de la tienda con los filtros (solo lo que difiere de los valores por defecto). */
export function toUrlSearch(f: Filters, defaultSort: SortKey = 'novedades'): string {
  const q = new URLSearchParams();
  if (f.q) q.set('q', f.q);
  if (f.sizes.length) q.set('talla', f.sizes.join(','));
  if (f.colors.length) q.set('color', f.colors.join(','));
  if (f.brands.length) q.set('marca', f.brands.join(','));
  if (f.genders.length) q.set('genero', f.genders.join(','));
  if (f.minPrice !== null || f.maxPrice !== null) q.set('precio', `${f.minPrice ?? ''}-${f.maxPrice ?? ''}`);
  if (f.onSale) q.set('ofertas', '1');
  if (f.sort !== defaultSort) q.set('orden', f.sort);
  if (f.page > 1) q.set('pagina', String(f.page));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Activa o desactiva un valor de un filtro de lista (vuelve a la página 1). */
export function toggle(f: Filters, key: 'sizes' | 'colors' | 'brands' | 'genders', value: string): Filters {
  const list = f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value];
  return { ...f, [key]: list, page: 1 };
}

export function clearFilters(f: Filters): Filters {
  return { ...f, sizes: [], colors: [], brands: [], genders: [], minPrice: null, maxPrice: null, onSale: false, page: 1 };
}
