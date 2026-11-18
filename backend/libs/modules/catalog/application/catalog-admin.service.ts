import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  APP_CONFIG,
  AppConfig,
  AuditLog,
  currentRequestContext,
  Database,
  ivaRateBp,
  NotFoundError,
  Queryable,
  sniffFileType,
  StoredObject,
  ValidationError,
} from '../../../shared-kernel';
import {
  assertCompareAtAbovePrice,
  assertVariantsKeepDiscount,
  CatalogMediaNotFoundError,
  CatalogProductNotFoundAdminError,
  CatalogVariantNotFoundError,
  effectivePrice,
  InvalidReferenceError,
  MAX_BULK_PRICE_ROWS,
  nextFreeSlug,
  normalizeMoney,
  ProductFields,
  ProductStatus,
  SizeSystem,
  SlugTakenError,
  slugify,
  SkuTakenError,
  BarcodeTakenError,
  StaleProductError,
  VariantDuplicateError,
  VariantStatus,
  VARIANT_LOOKUP_LIMIT,
} from '../domain/admin-catalog';
import { Gender, mediaUrl } from '../domain/storefront';
import {
  AdminMedia,
  AdminProductDetail,
  AdminProductListItem,
  AdminProductListQuery,
  AdminVariant,
  CatalogAdminRepository,
  Lookups,
  ProductMediaStorage,
  ReferenceIds,
  VariantFields,
  VariantLookupItem,
} from './admin-ports';

/** Quién hace el cambio (va a platform.audit_log). */
export interface CatalogActor {
  tenantId: string;
  id: string;
  type: string;
  ip: string | null;
}

/** Montos como string "12.50" (o number); null limpia el campo opcional. */
type Money = string | number;

export interface CreateProductInput {
  name: string;
  slug?: string;
  description?: string | null;
  categoryId: string;
  brandId?: string | null;
  sizeChartId?: string | null;
  gender: Gender;
  season?: string | null;
  material?: string | null;
  careInstructions?: string | null;
  basePrice: Money;
  compareAtPrice?: Money | null;
  cost?: Money | null;
  taxCode?: string;
  status?: ProductStatus;
}

export type UpdateProductInput = Partial<Omit<CreateProductInput, 'slug'>> & { slug?: string; expectedUpdatedAt: string };

export interface CreateVariantInput {
  sku: string;
  barcode?: string | null;
  colorId?: string | null;
  sizeId?: string | null;
  price?: Money | null;
  compareAtPrice?: Money | null;
  weightG?: number;
  status?: VariantStatus;
}

export type UpdateVariantInput = Partial<CreateVariantInput>;

export interface BulkPriceInput {
  products?: { id: string; basePrice?: Money; compareAtPrice?: Money | null }[];
  variants?: { id: string; price?: Money | null; compareAtPrice?: Money | null }[];
}

export interface MediaFile {
  buffer: Buffer;
  size: number;
}

export const PRODUCT_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
const MEDIA_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/** Nombre de archivo de una foto de producto dentro de su prefijo. */
export const MEDIA_FILE_RE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

const PRODUCT_KEYS: (keyof ProductFields)[] = [
  'name',
  'slug',
  'description',
  'categoryId',
  'brandId',
  'sizeChartId',
  'gender',
  'season',
  'material',
  'careInstructions',
  'basePrice',
  'compareAtPrice',
  'cost',
  'taxCode',
  'status',
];
const VARIANT_KEYS: (keyof VariantFields)[] = ['sku', 'barcode', 'colorId', 'sizeId', 'price', 'compareAtPrice', 'weightG', 'status'];

/**
 * Administración del catálogo para el backoffice: productos, variantes, precios masivos, tablas
 * auxiliares (marcas, categorías, colores, tallas), fotos y búsqueda de variantes por código de
 * barras. Cada cambio de producto, variante o precio deja su fila en platform.audit_log en la
 * MISMA transacción (con before/after), como los cambios de roles en IAM.
 */
@Injectable()
export class CatalogAdminService {
  private readonly mediaBaseUrl: string;

  constructor(
    private readonly db: Database,
    private readonly repo: CatalogAdminRepository,
    private readonly audit: AuditLog,
    private readonly storage: ProductMediaStorage,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.mediaBaseUrl = config.catalog.mediaBaseUrl;
  }

  listProducts(tenantId: string, query: AdminProductListQuery): Promise<{ items: AdminProductListItem[]; total: number }> {
    return this.repo.listProducts(this.db, tenantId, query);
  }

  async getProduct(tenantId: string, id: string, q: Queryable = this.db): Promise<AdminProductDetail> {
    const product = await this.repo.productDetail(q, tenantId, id, this.mediaBaseUrl);
    if (!product) throw new CatalogProductNotFoundAdminError(id);
    return product;
  }

  async createProduct(actor: CatalogActor, input: CreateProductInput): Promise<AdminProductDetail> {
    const fields: ProductFields = {
      name: input.name.trim(),
      slug: input.slug ?? '',
      description: input.description ?? null,
      categoryId: input.categoryId,
      brandId: input.brandId ?? null,
      sizeChartId: input.sizeChartId ?? null,
      gender: input.gender,
      season: input.season ?? null,
      material: input.material ?? null,
      careInstructions: input.careInstructions ?? null,
      basePrice: normalizeMoney(input.basePrice),
      compareAtPrice: normalizeMoney(input.compareAtPrice ?? null),
      cost: normalizeMoney(input.cost ?? null),
      taxCode: input.taxCode ?? '4',
      status: input.status ?? 'draft',
    };
    assertProductRules(fields);

    return this.db.withTransaction(async (tx) => {
      await this.assertReferences(tx, actor.tenantId, { categoryId: fields.categoryId, brandId: fields.brandId, sizeChartId: fields.sizeChartId });
      if (input.slug) {
        if (await this.repo.slugExists(tx, actor.tenantId, input.slug)) throw new SlugTakenError(input.slug);
      } else {
        const base = slugify(fields.name);
        fields.slug = nextFreeSlug(base, await this.repo.slugsLike(tx, actor.tenantId, base));
      }
      const id = await this.repo.insertProduct(tx, actor.tenantId, fields);
      await this.record(tx, actor, 'catalog.product.created', 'product', id, undefined, fields);
      return this.getProduct(actor.tenantId, id, tx);
    });
  }

  /**
   * Edición con concurrencia optimista: expectedUpdatedAt es el updatedAt que el backoffice leyó.
   * Si otro usuario guardó antes, 409 STALE_PRODUCT (no se pisan cambios ajenos).
   */
  async updateProduct(actor: CatalogActor, id: string, input: UpdateProductInput): Promise<AdminProductDetail> {
    return this.db.withTransaction(async (tx) => {
      const current = await this.repo.findProduct(tx, actor.tenantId, id, true);
      if (!current) throw new CatalogProductNotFoundAdminError(id);
      if (new Date(input.expectedUpdatedAt).getTime() !== new Date(current.updatedAt).getTime()) {
        throw new StaleProductError(id, current.updatedAt);
      }

      const requested: Partial<ProductFields> = {
        name: input.name?.trim(),
        slug: input.slug,
        description: input.description,
        categoryId: input.categoryId,
        brandId: input.brandId,
        sizeChartId: input.sizeChartId,
        gender: input.gender,
        season: input.season,
        material: input.material,
        careInstructions: input.careInstructions,
        basePrice: input.basePrice === undefined ? undefined : normalizeMoney(input.basePrice),
        compareAtPrice: normalizeMoney(input.compareAtPrice),
        cost: normalizeMoney(input.cost),
        taxCode: input.taxCode,
        status: input.status,
      };
      const patch = diff(current, requested, PRODUCT_KEYS);
      if (Object.keys(patch).length === 0) return this.getProduct(actor.tenantId, id, tx);

      assertProductRules({ ...current, ...patch });
      await this.assertReferences(tx, actor.tenantId, { categoryId: patch.categoryId, brandId: patch.brandId, sizeChartId: patch.sizeChartId });
      if (patch.slug !== undefined && (await this.repo.slugExists(tx, actor.tenantId, patch.slug, id))) throw new SlugTakenError(patch.slug);

      await this.repo.updateProduct(tx, actor.tenantId, id, patch);
      if (patch.basePrice !== undefined) await this.assertHeirsKeepDiscount(tx, [id]);
      const before = pick(current, Object.keys(patch) as (keyof ProductFields)[]);
      await this.record(tx, actor, 'catalog.product.updated', 'product', id, before, patch);
      return this.getProduct(actor.tenantId, id, tx);
    });
  }

  async createVariant(actor: CatalogActor, productId: string, input: CreateVariantInput): Promise<AdminVariant> {
    const fields: VariantFields = {
      sku: input.sku.trim(),
      barcode: input.barcode?.trim() || null,
      colorId: input.colorId ?? null,
      sizeId: input.sizeId ?? null,
      price: normalizeMoney(input.price ?? null),
      compareAtPrice: normalizeMoney(input.compareAtPrice ?? null),
      weightG: input.weightG ?? 300,
      status: input.status ?? 'active',
    };
    return this.db.withTransaction(async (tx) => {
      const product = await this.repo.findProduct(tx, actor.tenantId, productId);
      if (!product) throw new CatalogProductNotFoundAdminError(productId);
      assertCompareAtAbovePrice(effectivePrice(fields.price, product.basePrice), fields.compareAtPrice);
      await this.assertReferences(tx, actor.tenantId, { colorId: fields.colorId, sizeId: fields.sizeId });
      await this.assertVariantUnique(tx, productId, fields);
      const id = await this.repo.insertVariant(tx, productId, fields);
      await this.record(tx, actor, 'catalog.variant.created', 'variant', id, undefined, { productId, ...fields });
      return (await this.repo.variantView(tx, actor.tenantId, id))!;
    });
  }

  async updateVariant(actor: CatalogActor, id: string, input: UpdateVariantInput): Promise<AdminVariant> {
    return this.db.withTransaction(async (tx) => {
      const current = await this.repo.findVariant(tx, actor.tenantId, id, true);
      if (!current) throw new CatalogVariantNotFoundError(id);
      const requested: Partial<VariantFields> = {
        sku: input.sku?.trim(),
        barcode: input.barcode === undefined ? undefined : input.barcode?.trim() || null,
        colorId: input.colorId,
        sizeId: input.sizeId,
        price: normalizeMoney(input.price),
        compareAtPrice: normalizeMoney(input.compareAtPrice),
        weightG: input.weightG,
        status: input.status,
      };
      const patch = diff(current, requested, VARIANT_KEYS);
      if (Object.keys(patch).length > 0) {
        const next = { ...current, ...patch };
        assertCompareAtAbovePrice(effectivePrice(next.price, current.productBasePrice), next.compareAtPrice);
        await this.assertReferences(tx, actor.tenantId, { colorId: patch.colorId, sizeId: patch.sizeId });
        await this.assertVariantUnique(tx, current.productId, next, id, patch);
        await this.repo.updateVariant(tx, id, patch);
        await this.record(tx, actor, 'catalog.variant.updated', 'variant', id, pick(current, Object.keys(patch) as (keyof VariantFields)[]), patch);
      }
      return (await this.repo.variantView(tx, actor.tenantId, id))!;
    });
  }

  /**
   * Cambio masivo de precios en UNA transacción: si un id no existe (o es de otro tenant) o un
   * precio no cuadra, no se aplica nada. Devuelve los ids que de verdad cambiaron.
   */
  async bulkPrices(actor: CatalogActor, input: BulkPriceInput): Promise<{ products: string[]; variants: string[] }> {
    const products = input.products ?? [];
    const variants = input.variants ?? [];
    if (products.length + variants.length === 0) throw new ValidationError('EMPTY_PRICE_CHANGE', 'Envía al menos un producto o una variante');
    if (products.length + variants.length > MAX_BULK_PRICE_ROWS) {
      throw new ValidationError('TOO_MANY_ROWS', `Máximo ${MAX_BULK_PRICE_ROWS} filas por cambio de precios`, { max: MAX_BULK_PRICE_ROWS });
    }
    assertNoDuplicates(products.map((p) => p.id), 'products');
    assertNoDuplicates(variants.map((v) => v.id), 'variants');

    return this.db.withTransaction(async (tx) => {
      const changed = { products: [] as string[], variants: [] as string[] };

      const productRows = new Map((await this.repo.lockProductPrices(tx, actor.tenantId, products.map((p) => p.id))).map((r) => [r.id, r]));
      for (const p of products) {
        const cur = productRows.get(p.id);
        if (!cur) throw new CatalogProductNotFoundAdminError(p.id);
        const basePrice = p.basePrice === undefined ? cur.basePrice : normalizeMoney(p.basePrice);
        const compareAtPrice = p.compareAtPrice === undefined ? cur.compareAtPrice : normalizeMoney(p.compareAtPrice);
        assertCompareAtAbovePrice(basePrice, compareAtPrice);
        if (basePrice === cur.basePrice && compareAtPrice === cur.compareAtPrice) continue;
        await this.repo.setProductPrices(tx, p.id, basePrice, compareAtPrice);
        await this.record(tx, actor, 'catalog.product.price_changed', 'product', p.id, { basePrice: cur.basePrice, compareAtPrice: cur.compareAtPrice }, { basePrice, compareAtPrice });
        changed.products.push(p.id);
      }

      const variantRows = await this.repo.lockVariantPrices(tx, actor.tenantId, variants.map((v) => v.id));
      const byId = new Map(variantRows.map((r) => [r.id, r]));
      const bases = await this.repo.productPrices(tx, [...new Set(variantRows.map((r) => r.productId))]);
      for (const v of variants) {
        const cur = byId.get(v.id);
        if (!cur) throw new CatalogVariantNotFoundError(v.id);
        const price = v.price === undefined ? cur.price : normalizeMoney(v.price);
        const compareAtPrice = v.compareAtPrice === undefined ? cur.compareAtPrice : normalizeMoney(v.compareAtPrice);
        assertCompareAtAbovePrice(effectivePrice(price, bases.get(cur.productId)!.basePrice), compareAtPrice, `variants[${v.id}].compareAtPrice`);
        if (price === cur.price && compareAtPrice === cur.compareAtPrice) continue;
        await this.repo.setVariantPrices(tx, v.id, price, compareAtPrice);
        await this.record(tx, actor, 'catalog.variant.price_changed', 'variant', v.id, { price: cur.price, compareAtPrice: cur.compareAtPrice }, { price, compareAtPrice });
        changed.variants.push(v.id);
      }
      // Con todo aplicado (también las variantes de esta misma petición), las que heredan el
      // precio de un producto que cambió no pueden quedar con una rebaja falsa.
      await this.assertHeirsKeepDiscount(tx, changed.products);
      return changed;
    });
  }

  lookups(tenantId: string): Promise<Lookups> {
    return this.repo.lookups(this.db, tenantId);
  }

  createBrand(actor: CatalogActor, name: string) {
    return this.repo.insertBrand(this.db, actor.tenantId, name.trim(), slugify(name));
  }

  async createCategory(actor: CatalogActor, name: string, parentId: string | null) {
    const slug = slugify(name);
    let path = slug;
    if (parentId) {
      const parent = await this.repo.findCategory(this.db, actor.tenantId, parentId);
      if (!parent) throw new InvalidReferenceError('parentId', parentId);
      path = `${parent.path}/${slug}`;
    }
    return this.repo.insertCategory(this.db, actor.tenantId, { parentId, name: name.trim(), slug, path });
  }

  createColor(actor: CatalogActor, name: string, hex: string | null) {
    return this.repo.insertColor(this.db, actor.tenantId, name.trim(), hex ? hex.toLowerCase() : null);
  }

  createSize(actor: CatalogActor, code: string, sizeSystem: SizeSystem, sortOrder: number) {
    return this.repo.insertSize(this.db, actor.tenantId, { code: code.trim(), sizeSystem, sortOrder });
  }

  /**
   * Búsqueda de variantes para Bodega (escaneo) y Vendedor: barcode exacto (0 o 1), ids (las del
   * tenant, para nombrar lo que muestra Inventario) o texto (máx. 20). Prioridad: barcode, ids, q.
   */
  lookupVariants(tenantId: string, by: { barcode?: string; ids?: string[]; q?: string }): Promise<VariantLookupItem[]> {
    if (by.barcode) return this.repo.lookupVariants(this.db, tenantId, { barcode: by.barcode.trim() });
    if (by.ids && by.ids.length > 0) return this.repo.lookupVariants(this.db, tenantId, { ids: [...new Set(by.ids)] });
    if (by.q && by.q.trim().length > 0) return this.repo.lookupVariants(this.db, tenantId, { text: by.q.trim(), limit: VARIANT_LOOKUP_LIMIT });
    throw new ValidationError('LOOKUP_QUERY_REQUIRED', 'Indica barcode, ids o q');
  }

  /** Foto de producto (jpg, png o webp ≤ 5 MB, tipo verificado por magic bytes). */
  async uploadMedia(
    actor: CatalogActor,
    productId: string,
    file: MediaFile | undefined,
    opts: { colorId?: string | null; altText?: string | null },
  ): Promise<AdminMedia> {
    if (!file || file.size === 0) throw new ValidationError('MEDIA_REQUIRED', 'Adjunta la imagen (campo "file")');
    if (file.size > PRODUCT_MEDIA_MAX_BYTES) throw new ValidationError('MEDIA_TOO_LARGE', 'La imagen supera 5 MB');
    const type = sniffFileType(file.buffer);
    const ext = type ? MEDIA_EXT[type] : undefined;
    if (!type || !ext) throw new ValidationError('MEDIA_TYPE', 'La imagen debe ser JPG, PNG o WEBP');

    const product = await this.repo.findProduct(this.db, actor.tenantId, productId);
    if (!product) throw new CatalogProductNotFoundAdminError(productId);
    const colorId = opts.colorId ?? null;
    await this.assertReferences(this.db, actor.tenantId, { colorId });

    const storageKey = `${mediaPrefix(actor.tenantId, productId)}${randomUUID()}.${ext}`;
    await this.storage.put(storageKey, file.buffer, type);
    const row = await this.repo.insertMedia(this.db, { productId, colorId, storageKey, altText: opts.altText ?? null, width: null, height: null });
    return { id: row.id, url: mediaUrl(this.mediaBaseUrl, storageKey), colorId, sortOrder: row.sortOrder, altText: opts.altText ?? null };
  }

  /** Quita la foto del producto. El archivo queda en el almacén (el puerto no tiene borrado). */
  async deleteMedia(actor: CatalogActor, id: string): Promise<{ id: string; deleted: true }> {
    const media = await this.repo.findMedia(this.db, actor.tenantId, id);
    if (!media) throw new CatalogMediaNotFoundError(id);
    await this.repo.deleteMedia(this.db, id);
    return { id, deleted: true };
  }

  /** Cambia el color (null = todas), el texto alternativo o el orden de una foto ya subida. */
  async updateMedia(
    actor: CatalogActor,
    id: string,
    patch: { colorId?: string | null; altText?: string | null; sortOrder?: number },
  ): Promise<AdminMedia> {
    const media = await this.repo.findMedia(this.db, actor.tenantId, id);
    if (!media) throw new CatalogMediaNotFoundError(id);
    if (patch.colorId) await this.assertReferences(this.db, actor.tenantId, { colorId: patch.colorId });
    const altText = patch.altText === undefined ? undefined : patch.altText?.trim() || null;
    const row = await this.repo.updateMedia(this.db, id, { colorId: patch.colorId, altText, sortOrder: patch.sortOrder });
    return { id: row.id, url: mediaUrl(this.mediaBaseUrl, row.storageKey), colorId: row.colorId, sortOrder: row.sortOrder, altText: row.altText };
  }

  /** Archivo de una foto subida desde el backoffice (lectura pública, como las fotos de la tienda). */
  async mediaFile(tenantId: string, productId: string, file: string): Promise<StoredObject> {
    if (!MEDIA_FILE_RE.test(file)) throw new NotFoundError('MEDIA_NOT_FOUND', 'La foto no existe');
    const stored = await this.storage.get(`${mediaPrefix(tenantId, productId)}${file}`);
    if (!stored) throw new NotFoundError('MEDIA_NOT_FOUND', 'La foto no existe');
    return stored;
  }

  /**
   * Revalida, con el estado final de la transacción, las variantes que heredan el precio de esos
   * productos (price NULL) y tienen tachado: 422 INVALID_PRICE con details.variantIds → ROLLBACK.
   */
  private async assertHeirsKeepDiscount(tx: Queryable, productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;
    const heirs = await this.repo.inheritingVariantsWithCompareAt(tx, productIds);
    if (heirs.length === 0) return;
    const prices = await this.repo.productPrices(tx, productIds);
    for (const productId of productIds) {
      assertVariantsKeepDiscount(productId, prices.get(productId)!.basePrice, heirs.filter((v) => v.productId === productId));
    }
  }

  private async assertReferences(q: Queryable, tenantId: string, refs: ReferenceIds): Promise<void> {
    const missing = await this.repo.missingReferences(q, tenantId, refs);
    if (missing.length > 0) throw new InvalidReferenceError(missing[0], String(refs[missing[0] as keyof ReferenceIds]));
  }

  /** SKU y código de barras son únicos en toda la base; color + talla, dentro del producto. */
  private async assertVariantUnique(
    q: Queryable,
    productId: string,
    next: VariantFields,
    exceptId?: string,
    patch: Partial<VariantFields> = next,
  ): Promise<void> {
    if (patch.sku !== undefined && (await this.repo.skuExists(q, next.sku, exceptId))) throw new SkuTakenError(next.sku);
    if (patch.barcode && (await this.repo.barcodeExists(q, patch.barcode, exceptId))) throw new BarcodeTakenError(patch.barcode);
    if ((patch.colorId !== undefined || patch.sizeId !== undefined) && (await this.repo.comboExists(q, productId, next.colorId, next.sizeId, exceptId))) {
      throw new VariantDuplicateError();
    }
  }

  private record(q: Queryable, actor: CatalogActor, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
    return this.audit.record(q, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorType: actor.type,
      actorIp: actor.ip,
      action,
      entityType,
      entityId,
      before,
      after,
      requestId: currentRequestContext()?.requestId ?? null,
    });
  }
}

export function mediaPrefix(tenantId: string, productId: string): string {
  return `products/${tenantId}/${productId}/`;
}

/** Reglas de un producto completo: precio tachado mayor que el de venta e IVA conocido. */
function assertProductRules(p: Pick<ProductFields, 'basePrice' | 'compareAtPrice' | 'taxCode'>): void {
  assertCompareAtAbovePrice(p.basePrice, p.compareAtPrice);
  ivaRateBp(p.taxCode);
}

/** Solo las claves pedidas (≠ undefined) cuyo valor cambia respecto del registro actual. */
function diff<T extends object>(current: T, requested: Partial<T>, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) {
    const v = requested[k];
    if (v !== undefined && v !== current[k]) out[k] = v;
  }
  return out;
}

function pick<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

function assertNoDuplicates(ids: string[], field: string): void {
  if (new Set(ids).size !== ids.length) throw new ValidationError('DUPLICATE_ROWS', `${field} repite un id`, { field });
}
