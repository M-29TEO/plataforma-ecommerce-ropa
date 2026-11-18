import { Queryable } from '../../../shared-kernel';
import { CategoryRef, Facets, ListingQuery, MediaView, ProductCard, ProductDetail } from '../domain/storefront';

export interface CategoryNode extends CategoryRef {
  id: string;
  parentPath: string | null;
  sortOrder: number;
  /** Productos publicados en la categoría y sus subcategorías. */
  productCount: number;
}

export interface BrandView {
  name: string;
  slug: string;
  logoUrl: string | null;
  productCount: number;
}

export interface CollectionView {
  name: string;
  slug: string;
  startsAt: string | null;
  endsAt: string | null;
}

export interface Suggestions {
  products: Array<{ slug: string; name: string; price: string; imageUrl: string | null }>;
  categories: CategoryRef[];
  brands: Array<{ name: string; slug: string }>;
}

/** Datos mínimos para pintar una línea de carrito, wishlist o pedido (que no guardan foto ni slug). */
export interface ProductThumb {
  id: string;
  slug: string;
  name: string;
  images: MediaView[];
}

export interface SitemapEntry {
  type: 'product' | 'category' | 'brand';
  /** Slug del producto o de la marca; ruta de la categoría. */
  key: string;
  updatedAt: string | null;
}

/** Vista de producto con los ids de variante, que el servicio usa para consultar Inventario. */
export type ProductDetailRow = Omit<ProductDetail, 'variants'> & {
  variants: Array<Omit<ProductDetail['variants'][number], 'stock'>>;
};

/**
 * Lectura del catálogo público. Solo productos publicados: status 'active', sin borrar, con
 * published_at vencido (o sin fecha), en una categoría activa y con al menos una variante activa.
 */
export abstract class StorefrontReader {
  abstract list(q: Queryable, tenantId: string, query: ListingQuery, mediaBaseUrl: string): Promise<{ items: ProductCard[]; total: number }>;
  abstract facets(q: Queryable, tenantId: string, query: ListingQuery): Promise<Facets>;
  abstract findBySlug(q: Queryable, tenantId: string, slug: string, mediaBaseUrl: string): Promise<ProductDetailRow | null>;
  abstract categories(q: Queryable, tenantId: string): Promise<CategoryNode[]>;
  abstract brands(q: Queryable, tenantId: string): Promise<BrandView[]>;
  abstract collections(q: Queryable, tenantId: string, now: Date): Promise<CollectionView[]>;
  abstract suggest(q: Queryable, tenantId: string, text: string, mediaBaseUrl: string): Promise<Suggestions>;
  abstract sitemap(q: Queryable, tenantId: string, limit: number): Promise<SitemapEntry[]>;
  /** Productos publicados con esos ids (los demás no aparecen), con todas sus fotos. */
  abstract thumbs(q: Queryable, tenantId: string, ids: string[], mediaBaseUrl: string): Promise<ProductThumb[]>;
}
