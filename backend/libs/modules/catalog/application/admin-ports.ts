import { ObjectStorage, Queryable } from '../../../shared-kernel';
import { ProductFields, ProductStatus, SizeSystem, VariantStatus } from '../domain/admin-catalog';

/** Puertos de la administración del catálogo (backoffice). Solo schema catalog. */

export interface AdminProductListQuery {
  q?: string;
  status?: ProductStatus;
  categoryId?: string;
  brandId?: string;
  limit: number;
  offset: number;
}

export interface AdminProductListItem {
  id: string;
  name: string;
  slug: string;
  status: ProductStatus;
  brand: { id: string; name: string } | null;
  category: { id: string; name: string; path: string };
  gender: string;
  basePrice: string;
  compareAtPrice: string | null;
  cost: string | null;
  variantCount: number;
  updatedAt: string;
}

/** Fila de catalog.products tal como la edita el backoffice. updatedAt (ISO, ms) es el token de concurrencia. */
export interface ProductRecord extends ProductFields {
  id: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminVariant {
  id: string;
  sku: string;
  barcode: string | null;
  color: { id: string; name: string; hex: string | null } | null;
  size: { id: string; code: string } | null;
  price: string | null;
  compareAtPrice: string | null;
  effectivePrice: string;
  weightG: number;
  status: VariantStatus;
}

export interface AdminMedia {
  id: string;
  url: string;
  colorId: string | null;
  sortOrder: number;
  altText: string | null;
}

export interface AdminProductDetail extends ProductRecord {
  brand: { id: string; name: string } | null;
  category: { id: string; name: string; path: string };
  variants: AdminVariant[];
  media: AdminMedia[];
}

export interface VariantFields {
  sku: string;
  barcode: string | null;
  colorId: string | null;
  sizeId: string | null;
  price: string | null;
  compareAtPrice: string | null;
  weightG: number;
  status: VariantStatus;
}

export interface VariantRecord extends VariantFields {
  id: string;
  productId: string;
  /** base_price del producto: precio efectivo cuando la variante no tiene el suyo. */
  productBasePrice: string;
}

export interface VariantLookupItem {
  variantId: string;
  productId: string;
  sku: string;
  barcode: string | null;
  productName: string;
  color: string | null;
  size: string | null;
  /** Precio efectivo (el de la variante o el del producto), sin IVA. */
  price: string;
  status: VariantStatus;
  productStatus: ProductStatus;
}

export interface Lookups {
  brands: { id: string; name: string; slug: string; active: boolean }[];
  categories: { id: string; parentId: string | null; name: string; slug: string; path: string; active: boolean }[];
  colors: { id: string; name: string; hex: string | null }[];
  sizes: { id: string; code: string; sizeSystem: SizeSystem; sortOrder: number }[];
  sizeCharts: { id: string; name: string }[];
}

export interface ReferenceIds {
  categoryId?: string;
  brandId?: string | null;
  sizeChartId?: string | null;
  colorId?: string | null;
  sizeId?: string | null;
}

export interface MediaRecord {
  id: string;
  productId: string;
  storageKey: string;
}

export abstract class CatalogAdminRepository {
  abstract listProducts(q: Queryable, tenantId: string, query: AdminProductListQuery): Promise<{ items: AdminProductListItem[]; total: number }>;
  /** forUpdate: bloquea la fila (SELECT ... FOR UPDATE) dentro de la transacción. */
  abstract findProduct(q: Queryable, tenantId: string, id: string, forUpdate?: boolean): Promise<ProductRecord | null>;
  abstract productDetail(q: Queryable, tenantId: string, id: string, mediaBaseUrl: string): Promise<AdminProductDetail | null>;
  /** Slugs del tenant iguales a base o con la forma base-N. */
  abstract slugsLike(q: Queryable, tenantId: string, base: string): Promise<string[]>;
  abstract slugExists(q: Queryable, tenantId: string, slug: string, exceptId?: string): Promise<boolean>;
  /** Nombres de los campos cuyas referencias no existen en el tenant. */
  abstract missingReferences(q: Queryable, tenantId: string, refs: ReferenceIds): Promise<string[]>;
  abstract insertProduct(q: Queryable, tenantId: string, fields: ProductFields): Promise<string>;
  /** Escribe el patch, avanza updated_at y fija published_at al activarse por primera vez. */
  abstract updateProduct(q: Queryable, tenantId: string, id: string, patch: Partial<ProductFields>): Promise<void>;

  abstract findVariant(q: Queryable, tenantId: string, id: string, forUpdate?: boolean): Promise<VariantRecord | null>;
  abstract skuExists(q: Queryable, sku: string, exceptId?: string): Promise<boolean>;
  abstract barcodeExists(q: Queryable, barcode: string, exceptId?: string): Promise<boolean>;
  /** Misma combinación color + talla en el producto (NULL cuenta como valor). */
  abstract comboExists(q: Queryable, productId: string, colorId: string | null, sizeId: string | null, exceptId?: string): Promise<boolean>;
  abstract insertVariant(q: Queryable, productId: string, fields: VariantFields): Promise<string>;
  abstract updateVariant(q: Queryable, id: string, patch: Partial<VariantFields>): Promise<void>;
  abstract variantView(q: Queryable, tenantId: string, id: string): Promise<AdminVariant | null>;

  /** Productos y variantes del tenant con esos ids, bloqueados para el cambio masivo de precios. */
  abstract lockProductPrices(q: Queryable, tenantId: string, ids: string[]): Promise<{ id: string; basePrice: string; compareAtPrice: string | null }[]>;
  abstract lockVariantPrices(
    q: Queryable,
    tenantId: string,
    ids: string[],
  ): Promise<{ id: string; productId: string; price: string | null; compareAtPrice: string | null }[]>;
  abstract setProductPrices(q: Queryable, id: string, basePrice: string, compareAtPrice: string | null): Promise<void>;
  abstract setVariantPrices(q: Queryable, id: string, price: string | null, compareAtPrice: string | null): Promise<void>;
  /** base_price y compare_at_price vigentes de esos productos (para validar las variantes). */
  abstract productPrices(q: Queryable, ids: string[]): Promise<Map<string, { basePrice: string; compareAtPrice: string | null }>>;
  /** Variantes que heredan el precio (price NULL) y tienen tachado, de esos productos (estado actual de la transacción). */
  abstract inheritingVariantsWithCompareAt(
    q: Queryable,
    productIds: string[],
  ): Promise<{ id: string; productId: string; price: string | null; compareAtPrice: string | null }[]>;

  abstract lookups(q: Queryable, tenantId: string): Promise<Lookups>;
  abstract insertBrand(q: Queryable, tenantId: string, name: string, slug: string): Promise<Lookups['brands'][number]>;
  abstract findCategory(q: Queryable, tenantId: string, id: string): Promise<{ id: string; path: string } | null>;
  abstract insertCategory(q: Queryable, tenantId: string, c: { parentId: string | null; name: string; slug: string; path: string }): Promise<Lookups['categories'][number]>;
  abstract insertColor(q: Queryable, tenantId: string, name: string, hex: string | null): Promise<Lookups['colors'][number]>;
  abstract insertSize(q: Queryable, tenantId: string, s: { code: string; sizeSystem: SizeSystem; sortOrder: number }): Promise<Lookups['sizes'][number]>;

  abstract lookupVariants(q: Queryable, tenantId: string, by: { barcode: string } | { ids: string[] } | { text: string; limit: number }): Promise<VariantLookupItem[]>;

  abstract insertMedia(
    q: Queryable,
    m: { productId: string; colorId: string | null; storageKey: string; altText: string | null; width: number | null; height: number | null },
  ): Promise<{ id: string; sortOrder: number }>;
  abstract findMedia(q: Queryable, tenantId: string, id: string): Promise<MediaRecord | null>;
  abstract deleteMedia(q: Queryable, id: string): Promise<void>;
  /** Cambia color, texto alternativo u orden de una foto; devuelve la fila resultante. */
  abstract updateMedia(
    q: Queryable,
    id: string,
    patch: { colorId?: string | null; altText?: string | null; sortOrder?: number },
  ): Promise<{ id: string; storageKey: string; colorId: string | null; sortOrder: number; altText: string | null }>;
}

/** Almacén de fotos de producto (SeaweedFS o memoria), claves products/<tenant>/<producto>/<uuid>.<ext>. */
export abstract class ProductMediaStorage extends ObjectStorage {}
