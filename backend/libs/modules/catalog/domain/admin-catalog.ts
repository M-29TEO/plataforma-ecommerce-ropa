import { ConflictError, NotFoundError, toCents, ValidationError } from '../../../shared-kernel';
import { Gender } from './storefront';

/**
 * Administración del catálogo (backoffice): reglas puras de slugs, precios y errores de negocio.
 * Los montos viajan como string "12.50" (numeric(12,2)), igual que en el resto de la API.
 */

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const VARIANT_STATUSES = ['active', 'inactive'] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

export const SIZE_SYSTEMS = ['alpha', 'numeric', 'shoe', 'kids'] as const;
export type SizeSystem = (typeof SIZE_SYSTEMS)[number];

/** Máximo de filas (productos + variantes) en un cambio masivo de precios. */
export const MAX_BULK_PRICE_ROWS = 200;
/** Máximo de resultados de la búsqueda de variantes por texto. */
export const VARIANT_LOOKUP_LIMIT = 20;
export const SLUG_MAX_LENGTH = 120;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * "Vestido Floral Año 2026!" → "vestido-floral-ano-2026". Sin tildes ni eñes, solo [a-z0-9-],
 * sin guiones repetidos ni en los extremos. Si no queda nada (nombre solo con símbolos), "producto".
 */
export function slugify(text: string, maxLength = SLUG_MAX_LENGTH): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'producto';
}

/**
 * Primer slug libre: base, base-2, base-3... `taken` son los slugs del tenant que empiezan por base.
 */
export function nextFreeSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Normaliza un monto a "12.50" (lanza INVALID_MONEY si no es válido). null se conserva. */
export function normalizeMoney(value: string | number): string;
export function normalizeMoney(value: string | number | null): string | null;
export function normalizeMoney(value: string | number | undefined | null): string | null | undefined;
export function normalizeMoney(value: string | number | undefined | null): string | null | undefined {
  if (value === undefined || value === null) return value;
  const cents = toCents(value);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * El precio tachado ("antes") debe ser MAYOR que el precio de venta; si no, la tienda mostraría
 * una rebaja falsa. null = sin precio tachado.
 */
export function assertCompareAtAbovePrice(price: string, compareAtPrice: string | null, field = 'compareAtPrice'): void {
  if (compareAtPrice === null) return;
  if (toCents(compareAtPrice) <= toCents(price)) {
    throw new InvalidPriceError(`${field} (${compareAtPrice}) debe ser mayor que el precio de venta (${price})`, { field, price, compareAtPrice });
  }
}

/** Precio que paga el cliente por una variante: el suyo o, si no tiene, el del producto. */
export function effectivePrice(variantPrice: string | null, basePrice: string): string {
  return variantPrice ?? basePrice;
}

/**
 * Variantes que quedarían con una rebaja falsa (tachado ≤ precio efectivo) con ese base_price.
 * Sirve para las que HEREDAN el precio del producto (price NULL): al cambiar el base_price, su
 * precio efectivo cambia aunque nadie las haya tocado.
 */
export function variantsWithFalseDiscount(
  basePrice: string,
  variants: { id: string; price: string | null; compareAtPrice: string | null }[],
): string[] {
  return variants
    .filter((v) => v.compareAtPrice !== null && toCents(v.compareAtPrice) <= toCents(effectivePrice(v.price, basePrice)))
    .map((v) => v.id);
}

/** Lanza INVALID_PRICE con details.variantIds si alguna variante queda con rebaja falsa. */
export function assertVariantsKeepDiscount(
  productId: string,
  basePrice: string,
  variants: { id: string; price: string | null; compareAtPrice: string | null }[],
): void {
  const variantIds = variantsWithFalseDiscount(basePrice, variants);
  if (variantIds.length > 0) {
    throw new InvalidPriceError(
      `Con el precio ${basePrice} hay variantes cuyo precio tachado no es mayor que su precio de venta: corrige su compareAtPrice en la misma petición`,
      { productId, basePrice, variantIds },
    );
  }
}

export interface ProductFields {
  name: string;
  slug: string;
  description: string | null;
  categoryId: string;
  brandId: string | null;
  sizeChartId: string | null;
  gender: Gender;
  season: string | null;
  material: string | null;
  careInstructions: string | null;
  basePrice: string;
  compareAtPrice: string | null;
  cost: string | null;
  taxCode: string;
  status: ProductStatus;
}

export class CatalogProductNotFoundAdminError extends NotFoundError {
  constructor(id: string) {
    super('PRODUCT_NOT_FOUND', 'El producto no existe en esta tienda', { id });
  }
}

export class CatalogVariantNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('VARIANT_NOT_FOUND', 'La variante no existe en esta tienda', { id });
  }
}

export class CatalogMediaNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('MEDIA_NOT_FOUND', 'La foto no existe en esta tienda', { id });
  }
}

export class SlugTakenError extends ConflictError {
  constructor(slug: string) {
    super('SLUG_TAKEN', `Ya existe un producto con el slug "${slug}"`, { slug });
  }
}

export class SkuTakenError extends ConflictError {
  constructor(sku: string) {
    super('SKU_TAKEN', `El SKU "${sku}" ya está en uso`, { sku });
  }
}

export class BarcodeTakenError extends ConflictError {
  constructor(barcode: string) {
    super('BARCODE_TAKEN', `El código de barras "${barcode}" ya está en uso`, { barcode });
  }
}

export class VariantDuplicateError extends ConflictError {
  constructor() {
    super('VARIANT_DUPLICATE', 'El producto ya tiene una variante con ese color y talla');
  }
}

/** Otro usuario guardó el producto después de que este lo abrió (concurrencia optimista). */
export class StaleProductError extends ConflictError {
  constructor(id: string, currentUpdatedAt: string) {
    super('STALE_PRODUCT', 'El producto cambió desde que lo abriste: recarga y vuelve a aplicar tus cambios', { id, currentUpdatedAt });
  }
}

/** Nombre repetido en marcas, categorías (misma ruta), colores o tallas. */
export class LookupTakenError extends ConflictError {
  constructor(kind: 'brand' | 'category' | 'color' | 'size', value: string) {
    super(`${kind.toUpperCase()}_TAKEN`, `Ya existe ${kind === 'brand' ? 'una marca' : kind === 'category' ? 'una categoría' : kind === 'color' ? 'un color' : 'una talla'} "${value}"`, { value });
  }
}

export class InvalidPriceError extends ValidationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_PRICE', message, details);
  }
}

/** Categoría, marca, guía de tallas, color o talla inexistente o de otro tenant. */
export class InvalidReferenceError extends ValidationError {
  constructor(field: string, id: string) {
    super('INVALID_REFERENCE', `${field} no existe en esta tienda`, { field, id });
  }
}
