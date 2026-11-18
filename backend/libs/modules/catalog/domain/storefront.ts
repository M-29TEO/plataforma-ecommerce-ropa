import { NotFoundError } from '../../../shared-kernel';

/**
 * Catálogo público (storefront): lo que ve un visitante. Solo lectura; los tipos no exponen costo,
 * proveedor ni nada que no se muestre en la tienda.
 */

/** Producto inexistente, borrado, en borrador o archivado: para el visitante es lo mismo. */
export class ProductSlugNotFoundError extends NotFoundError {
  constructor(slug: string) {
    super('PRODUCT_NOT_FOUND', 'El producto no existe', { slug });
  }
}

export const STOREFRONT_SORTS = ['relevance', 'newest', 'price_asc', 'price_desc', 'rating'] as const;
export type StorefrontSort = (typeof STOREFRONT_SORTS)[number];

export const GENDERS = ['women', 'men', 'unisex', 'girls', 'boys', 'baby'] as const;
export type Gender = (typeof GENDERS)[number];

export const GENDER_LABELS: Readonly<Record<Gender, string>> = {
  women: 'Mujer',
  men: 'Hombre',
  unisex: 'Unisex',
  girls: 'Niñas',
  boys: 'Niños',
  baby: 'Bebé',
};

export const MAX_PAGE_SIZE = 48;
export const MAX_FILTER_VALUES = 20;

/** Filtros del listado. Dentro de un mismo filtro los valores se combinan con O; entre filtros, con Y. */
export interface ListingFilter {
  /** Ruta de la categoría ('mujer/vestidos'): incluye las subcategorías. */
  category?: string;
  collection?: string;
  genders: Gender[];
  /** Slugs de marca. */
  brands: string[];
  /** Nombres de color (sin distinguir mayúsculas). */
  colors: string[];
  /** Códigos de talla ('S', '38'). */
  sizes: string[];
  minPrice?: string;
  maxPrice?: string;
  /** Solo productos con alguna variante rebajada (compare_at_price > precio). */
  onSale: boolean;
  q?: string;
}

export interface ListingQuery {
  filter: ListingFilter;
  sort: StorefrontSort;
  page: number;
  pageSize: number;
}

export interface MediaView {
  url: string;
  alt: string | null;
  colorName: string | null;
  width: number | null;
  height: number | null;
}

export interface ColorView {
  name: string;
  hex: string | null;
}

export interface ProductCard {
  id: string;
  slug: string;
  name: string;
  brand: { name: string; slug: string } | null;
  /** Precio más bajo entre las variantes activas. */
  price: string;
  /** Precio tachado de esa misma variante (null si no está rebajada). */
  compareAtPrice: string | null;
  images: MediaView[];
  colors: ColorView[];
  ratingAvg: string;
  ratingCount: number;
  /** Lo completa el servicio con el stock de Inventario. */
  available: boolean;
  /** Ids de las variantes activas (para consultar disponibilidad); no se devuelven al cliente. */
  variantIds: string[];
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
  /** Solo en colores. */
  hex?: string | null;
}

export interface Facets {
  brands: FacetValue[];
  colors: FacetValue[];
  sizes: FacetValue[];
  genders: FacetValue[];
  price: { min: string | null; max: string | null };
}

export interface ListingPage {
  items: Omit<ProductCard, 'variantIds'>[];
  total: number;
  page: number;
  pageSize: number;
  facets: Facets;
}

/**
 * Guía de tallas (catalog.size_charts.data). Formato acordado con el backoffice:
 * { unit: 'cm', columns: ['Talla', 'Pecho', ...], rows: [['S', '86-90', ...]], howToMeasure: ['...'] }
 */
export interface SizeChartView {
  name: string;
  data: Record<string, unknown>;
}

export interface VariantView {
  id: string;
  sku: string;
  color: ColorView | null;
  size: string | null;
  price: string;
  compareAtPrice: string | null;
  /** Lo completa el servicio con Inventario. */
  stock: StockLevel;
}

/** No se publica la cantidad exacta: solo si hay, si quedan pocas o si está agotada. */
export type StockLevel = 'in_stock' | 'low' | 'out_of_stock';
export const LOW_STOCK_THRESHOLD = 3;

export interface CategoryRef {
  name: string;
  slug: string;
  path: string;
}

export interface ProductDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  gender: Gender;
  material: string | null;
  careInstructions: string | null;
  attributes: Record<string, unknown>;
  seo: { title?: string; description?: string };
  brand: { name: string; slug: string } | null;
  category: CategoryRef;
  /** De la raíz a la categoría del producto. */
  breadcrumb: CategoryRef[];
  price: string;
  compareAtPrice: string | null;
  ratingAvg: string;
  ratingCount: number;
  media: MediaView[];
  colors: ColorView[];
  /** En el orden de catalog.sizes.sort_order. */
  sizes: string[];
  variants: VariantView[];
  sizeChart: SizeChartView | null;
  updatedAt: string;
}

export function stockLevel(available: number): StockLevel {
  if (available <= 0) return 'out_of_stock';
  return available <= LOW_STOCK_THRESHOLD ? 'low' : 'in_stock';
}

/**
 * URL pública de un medio. Las claves de SeaweedFS ('products/<id>/1.jpg') se sirven bajo
 * CATALOG_MEDIA_BASE_URL; una URL absoluta (http/https) se respeta tal cual.
 */
export function mediaUrl(baseUrl: string, storageKey: string): string {
  if (/^https?:\/\//i.test(storageKey)) return storageKey;
  return `${baseUrl.replace(/\/+$/, '')}/${storageKey.replace(/^\/+/, '')}`;
}

/** 'mujer/vestidos/casual' → ['mujer', 'mujer/vestidos', 'mujer/vestidos/casual']. */
export function categoryAncestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** Texto de búsqueda: espacios colapsados, sin caracteres de control y acotado a 100. Vacío → undefined. */
export function normalizeSearch(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const q = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return q.length > 0 ? q : undefined;
}

/** Escapa los comodines de LIKE/ILIKE (%, _ y \) para buscar el texto literal. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Lista de valores de un filtro en la URL: acepta 'a,b' o valores repetidos, recorta, quita
 * vacíos y duplicados y corta en MAX_FILTER_VALUES.
 */
export function parseList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const values = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  return [...new Set(values)].slice(0, MAX_FILTER_VALUES);
}

/** Sin texto de búsqueda no hay relevancia: se ordena por novedad. */
export function effectiveSort(sort: StorefrontSort, q: string | undefined): StorefrontSort {
  return sort === 'relevance' && !q ? 'newest' : sort;
}
