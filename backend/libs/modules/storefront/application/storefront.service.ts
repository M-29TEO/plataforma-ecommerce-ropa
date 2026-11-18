import { Injectable } from '@nestjs/common';
import {
  BrandView,
  CatalogStorefrontApi,
  CategoryNode,
  CollectionView,
  ListingPage,
  ListingQuery,
  ProductCard,
  ProductDetail,
  ProductThumb,
  SitemapEntry,
  stockLevel,
  Suggestions,
} from '../../catalog';
import { InventoryApi } from '../../inventory';

const RELATED_LIMIT = 8;
const SITEMAP_LIMIT = 10_000;

export type PublicCard = Omit<ProductCard, 'variantIds'>;

/**
 * Catálogo público para el storefront: listado con facetas, búsqueda, ficha de producto con
 * disponibilidad (de Inventario, sin publicar cantidades) y datos para el sitemap.
 */
@Injectable()
export class StorefrontService {
  constructor(
    private readonly catalog: CatalogStorefrontApi,
    private readonly inventory: InventoryApi,
  ) {}

  async list(tenantId: string, query: ListingQuery): Promise<ListingPage> {
    const [{ items, total }, facets] = await Promise.all([this.catalog.listProducts(tenantId, query), this.catalog.facets(tenantId, query)]);
    return { items: await this.withAvailability(tenantId, items), total, page: query.page, pageSize: query.pageSize, facets };
  }

  async product(tenantId: string, slug: string): Promise<ProductDetail & { related: PublicCard[] }> {
    const row = await this.catalog.getProduct(tenantId, slug);
    const [availability, related] = await Promise.all([
      this.inventory.getAvailability(tenantId, row.variants.map((v) => v.id)),
      this.catalog.listProducts(tenantId, {
        filter: { category: row.category.path, genders: [], brands: [], colors: [], sizes: [], onSale: false },
        sort: 'newest',
        page: 1,
        pageSize: RELATED_LIMIT + 1,
      }),
    ]);
    const relatedItems = related.items.filter((p) => p.id !== row.id).slice(0, RELATED_LIMIT);
    return {
      ...row,
      variants: row.variants.map((v) => ({ ...v, stock: stockLevel(availability.get(v.id) ?? 0) })),
      related: await this.withAvailability(tenantId, relatedItems),
    };
  }

  categories(tenantId: string): Promise<CategoryNode[]> {
    return this.catalog.categories(tenantId);
  }

  brands(tenantId: string): Promise<BrandView[]> {
    return this.catalog.brands(tenantId);
  }

  collections(tenantId: string): Promise<CollectionView[]> {
    return this.catalog.collections(tenantId);
  }

  suggest(tenantId: string, text: string): Promise<Suggestions> {
    return this.catalog.suggest(tenantId, text);
  }

  /** Foto y slug de las líneas de carrito, wishlist y pedidos (que guardan solo el productId). */
  thumbs(tenantId: string, ids: string[]): Promise<ProductThumb[]> {
    return this.catalog.thumbs(tenantId, ids);
  }

  sitemap(tenantId: string): Promise<SitemapEntry[]> {
    return this.catalog.sitemap(tenantId, SITEMAP_LIMIT);
  }

  /** Marca cada tarjeta como disponible si alguna de sus variantes tiene stock; quita los ids internos. */
  private async withAvailability(tenantId: string, items: ProductCard[]): Promise<PublicCard[]> {
    const availability = await this.inventory.getAvailability(tenantId, items.flatMap((i) => i.variantIds));
    return items.map(({ variantIds, ...card }) => ({
      ...card,
      available: variantIds.some((id) => (availability.get(id) ?? 0) > 0),
    }));
  }
}
