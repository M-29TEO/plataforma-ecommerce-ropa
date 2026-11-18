import { Queryable } from '../../../shared-kernel';
import { SellableVariant } from '../domain/sellable-variant';
import { ProductOffer } from '../domain/product-offer';

export abstract class VariantReader {
  /** Variantes del tenant con esos ids (las inexistentes o de otro tenant no aparecen). */
  abstract findSellable(q: Queryable, tenantId: string, variantIds: string[]): Promise<SellableVariant[]>;
  /**
   * Etiqueta de bodega (picking): sku, código de barras y la clave de la primera imagen del color de
   * la variante (o del producto). Incluye variantes inactivas o de productos borrados.
   */
  abstract findLabels(q: Queryable, tenantId: string, variantIds: string[]): Promise<VariantLabelRow[]>;
}

export interface VariantLabelRow {
  variantId: string;
  sku: string;
  barcode: string | null;
  imageKey: string | null;
}

export abstract class ProductOfferReader {
  /** Productos del tenant con esos ids (los inexistentes, de otro tenant o borrados no aparecen). */
  abstract findOffers(q: Queryable, tenantId: string, productIds: string[]): Promise<ProductOffer[]>;
}
