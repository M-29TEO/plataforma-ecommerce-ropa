import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database } from '../../../shared-kernel';
import { mediaUrl } from '../domain/storefront';
import { ProductOffer } from '../domain/product-offer';
import { SellableVariant } from '../domain/sellable-variant';
import { ProductOfferReader, VariantReader } from './ports';

/** Lo que la bodega necesita para escanear y reconocer una variante (picking). */
export interface VariantLabel {
  variantId: string;
  sku: string;
  barcode: string | null;
  imageUrl: string | null;
}

/**
 * Fachada de lectura del Catálogo para otros módulos: lo que necesitan Carrito y Checkout
 * (variantes vendibles) y CRM (resumen de productos de la wishlist). El CRUD del catálogo llegará
 * con el módulo completo.
 */
@Injectable()
export class CatalogApi {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantReader,
    private readonly offers: ProductOfferReader,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Mapa variantId → variante. Las que no existen en el tenant no están en el mapa. */
  async getSellableVariants(tenantId: string, variantIds: string[]): Promise<Map<string, SellableVariant>> {
    const unique = [...new Set(variantIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.variants.findSellable(this.db, tenantId, unique);
    return new Map(rows.map((v) => [v.variantId, v]));
  }

  /** Mapa productId → oferta. Los que no existen en el tenant (o están borrados) no están en el mapa. */
  async getProductOffers(tenantId: string, productIds: string[]): Promise<Map<string, ProductOffer>> {
    const unique = [...new Set(productIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.offers.findOffers(this.db, tenantId, unique);
    return new Map(rows.map((p) => [p.productId, p]));
  }

  /** Picking de bodega: mapa variantId → sku, código de barras e imagen. Incluye variantes inactivas. */
  async getVariantLabels(tenantId: string, variantIds: string[]): Promise<Map<string, VariantLabel>> {
    const unique = [...new Set(variantIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.variants.findLabels(this.db, tenantId, unique);
    const base = this.config.catalog.mediaBaseUrl;
    return new Map(
      rows.map((r) => [r.variantId, { variantId: r.variantId, sku: r.sku, barcode: r.barcode, imageUrl: r.imageKey ? mediaUrl(base, r.imageKey) : null }]),
    );
  }
}
