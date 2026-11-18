import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database } from '../../../shared-kernel';
import { Facets, ListingQuery, ProductCard, ProductSlugNotFoundError } from '../domain/storefront';
import { BrandView, CategoryNode, CollectionView, ProductDetailRow, ProductThumb, SitemapEntry, StorefrontReader, Suggestions } from './storefront-ports';

/**
 * Fachada de lectura del catálogo público para el orquestador Storefront. Solo el schema catalog:
 * la disponibilidad (Inventario) la agrega el orquestador con los variantIds de cada tarjeta.
 */
@Injectable()
export class CatalogStorefrontApi {
  private readonly mediaBaseUrl: string;

  constructor(
    private readonly db: Database,
    private readonly reader: StorefrontReader,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.mediaBaseUrl = config.catalog.mediaBaseUrl;
  }

  listProducts(tenantId: string, query: ListingQuery): Promise<{ items: ProductCard[]; total: number }> {
    return this.reader.list(this.db, tenantId, query, this.mediaBaseUrl);
  }

  facets(tenantId: string, query: ListingQuery): Promise<Facets> {
    return this.reader.facets(this.db, tenantId, query);
  }

  /** Producto publicado por slug; si no existe (o no está publicado), ProductSlugNotFoundError. */
  async getProduct(tenantId: string, slug: string): Promise<ProductDetailRow> {
    const row = await this.reader.findBySlug(this.db, tenantId, slug, this.mediaBaseUrl);
    if (!row) throw new ProductSlugNotFoundError(slug);
    return row;
  }

  categories(tenantId: string): Promise<CategoryNode[]> {
    return this.reader.categories(this.db, tenantId);
  }

  brands(tenantId: string): Promise<BrandView[]> {
    return this.reader.brands(this.db, tenantId);
  }

  collections(tenantId: string, now = new Date()): Promise<CollectionView[]> {
    return this.reader.collections(this.db, tenantId, now);
  }

  suggest(tenantId: string, text: string): Promise<Suggestions> {
    return this.reader.suggest(this.db, tenantId, text, this.mediaBaseUrl);
  }

  sitemap(tenantId: string, limit: number): Promise<SitemapEntry[]> {
    return this.reader.sitemap(this.db, tenantId, limit);
  }

  thumbs(tenantId: string, ids: string[]): Promise<ProductThumb[]> {
    const unique = [...new Set(ids)];
    return unique.length === 0 ? Promise.resolve([]) : this.reader.thumbs(this.db, tenantId, unique, this.mediaBaseUrl);
  }
}
