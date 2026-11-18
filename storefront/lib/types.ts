/** Respuestas del catálogo público (backend: libs/modules/catalog/domain/storefront.ts). */

export interface Media {
  url: string;
  alt: string | null;
  colorName: string | null;
  width: number | null;
  height: number | null;
}

export interface Color {
  name: string;
  hex: string | null;
}

export interface BrandRef {
  name: string;
  slug: string;
}

export interface ProductCard {
  id: string;
  slug: string;
  name: string;
  brand: BrandRef | null;
  price: string;
  compareAtPrice: string | null;
  images: Media[];
  colors: Color[];
  ratingAvg: string;
  ratingCount: number;
  available: boolean;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
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
  items: ProductCard[];
  total: number;
  page: number;
  pageSize: number;
  facets: Facets;
}

export type StockLevel = 'in_stock' | 'low' | 'out_of_stock';

export interface Variant {
  id: string;
  sku: string;
  color: Color | null;
  size: string | null;
  price: string;
  compareAtPrice: string | null;
  stock: StockLevel;
}

export interface CategoryRef {
  name: string;
  slug: string;
  path: string;
}

export interface SizeChartData {
  unit?: string;
  columns?: string[];
  rows?: string[][];
  howToMeasure?: string[];
}

export interface ProductDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  gender: string;
  material: string | null;
  careInstructions: string | null;
  attributes: Record<string, unknown>;
  seo: { title?: string; description?: string };
  brand: BrandRef | null;
  category: CategoryRef;
  breadcrumb: CategoryRef[];
  price: string;
  compareAtPrice: string | null;
  ratingAvg: string;
  ratingCount: number;
  media: Media[];
  colors: Color[];
  sizes: string[];
  variants: Variant[];
  sizeChart: { name: string; data: SizeChartData } | null;
  updatedAt: string;
  related: ProductCard[];
}

export interface CategoryNode extends CategoryRef {
  id: string;
  parentPath: string | null;
  sortOrder: number;
  productCount: number;
}

export interface Brand {
  name: string;
  slug: string;
  logoUrl: string | null;
  productCount: number;
}

export interface Collection {
  name: string;
  slug: string;
  startsAt: string | null;
  endsAt: string | null;
}

export interface Suggestions {
  products: Array<{ slug: string; name: string; price: string; imageUrl: string | null }>;
  categories: CategoryRef[];
  brands: BrandRef[];
}

export interface SitemapEntry {
  type: 'product' | 'category' | 'brand';
  key: string;
  updatedAt: string | null;
}

/** Cuerpo de error del API: { error: { code, message, details } }. */
export interface ApiErrorBody {
  error?: { code?: string; message?: string | string[]; details?: Record<string, unknown> };
  message?: string | string[];
}
