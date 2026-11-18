import type { Tone } from '@/components/ui/Badge';
import type { Money } from './types';

/**
 * Catálogo (backoffice): tipos de las respuestas de /catalog/admin/* y helpers puros de montos,
 * slugs, SKU, matriz de variantes, concurrencia optimista y precios masivos. Todo se prueba sin UI
 * en lib/catalog.test.ts. Los montos se operan en CENTAVOS enteros para no arrastrar errores de
 * coma flotante y viajan al API como string "12.50".
 */

// ───────────────────────────── Tipos del API ─────────────────────────────

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export type VariantStatus = 'active' | 'inactive';
export const GENDERS = ['women', 'men', 'unisex', 'girls', 'boys', 'baby'] as const;
export type Gender = (typeof GENDERS)[number];
export const SIZE_SYSTEMS = ['alpha', 'numeric', 'shoe', 'kids'] as const;
export type SizeSystem = (typeof SIZE_SYSTEMS)[number];

/** Máximo de filas (productos + variantes) por PATCH /catalog/admin/prices. */
export const MAX_PRICE_ROWS = 200;
/** Tamaño máximo de una foto (el API responde 422 MEDIA_TOO_LARGE por encima). */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const SLUG_MAX_LENGTH = 120;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
export const BARCODE_RE = /^[A-Za-z0-9-]{4,64}$/;
export const DEFAULT_TAX_CODE = '4';
export const DEFAULT_WEIGHT_G = 300;

/** Fila de GET /catalog/admin/products. */
export interface AdminProductListItem {
  id: string;
  name: string;
  slug: string;
  status: ProductStatus;
  brand: { id: string; name: string } | null;
  category: { id: string; name: string; path: string };
  gender: Gender;
  basePrice: Money;
  compareAtPrice: Money | null;
  cost: Money | null;
  variantCount: number;
  updatedAt: string;
}

export interface AdminVariant {
  id: string;
  sku: string;
  barcode: string | null;
  color: { id: string; name: string; hex: string | null } | null;
  size: { id: string; code: string } | null;
  /** null = hereda el precio base del producto. */
  price: Money | null;
  compareAtPrice: Money | null;
  effectivePrice: Money;
  weightG: number;
  status: VariantStatus;
}

export interface ProductMedia {
  id: string;
  url: string;
  colorId: string | null;
  sortOrder: number;
  altText: string | null;
}

/** GET /catalog/admin/products/:id */
export interface AdminProductDetail {
  id: string;
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
  basePrice: Money;
  compareAtPrice: Money | null;
  cost: Money | null;
  taxCode: string;
  status: ProductStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  brand: { id: string; name: string } | null;
  category: { id: string; name: string; path: string };
  variants: AdminVariant[];
  media: ProductMedia[];
}

export interface Brand {
  id: string;
  name: string;
  slug: string;
  active: boolean;
}
export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  path: string;
  active: boolean;
}
export interface Color {
  id: string;
  name: string;
  hex: string | null;
}
export interface Size {
  id: string;
  code: string;
  sizeSystem: SizeSystem;
  sortOrder: number;
}
export interface SizeChart {
  id: string;
  name: string;
}

/** GET /catalog/admin/lookups */
export interface Lookups {
  brands: Brand[];
  categories: Category[];
  colors: Color[];
  sizes: Size[];
  sizeCharts: SizeChart[];
}

export interface ProductPriceRow {
  id: string;
  basePrice?: string;
  compareAtPrice?: string | null;
}
export interface VariantPriceRow {
  id: string;
  price?: string | null;
  compareAtPrice?: string | null;
}
/** Cuerpo de PATCH /catalog/admin/prices. */
export interface BulkPricesBody {
  products: ProductPriceRow[];
  variants: VariantPriceRow[];
}
/** Respuesta de PATCH /catalog/admin/prices: ids que de verdad cambiaron. */
export interface BulkPricesResult {
  products: string[];
  variants: string[];
}

// ───────────────────────────── Etiquetas ─────────────────────────────

export const PRODUCT_STATUS: Record<ProductStatus, [string, Tone]> = {
  draft: ['Borrador', 'neutral'],
  active: ['Publicado', 'ok'],
  archived: ['Archivado', 'warn'],
};

export const VARIANT_STATUS: Record<VariantStatus, [string, Tone]> = {
  active: ['Activa', 'ok'],
  inactive: ['Inactiva', 'neutral'],
};

export const GENDER_LABEL: Record<Gender, string> = {
  women: 'Mujer',
  men: 'Hombre',
  unisex: 'Unisex',
  girls: 'Niña',
  boys: 'Niño',
  baby: 'Bebé',
};

export const SIZE_SYSTEM_LABEL: Record<SizeSystem, string> = {
  alpha: 'Letras (S, M, L)',
  numeric: 'Numérica (28, 30)',
  shoe: 'Calzado',
  kids: 'Infantil',
};

/** Códigos de porcentaje de IVA del SRI que acepta el API (tabla 17). */
export const TAX_CODES: readonly { code: string; label: string }[] = [
  { code: '4', label: 'IVA 15 % (tarifa general)' },
  { code: '5', label: 'IVA 5 %' },
  { code: '0', label: 'IVA 0 %' },
  { code: '6', label: 'No objeto de impuesto' },
  { code: '7', label: 'Exento de IVA' },
  { code: '10', label: 'IVA 13 % (histórico)' },
  { code: '2', label: 'IVA 12 % (histórico)' },
  { code: '3', label: 'IVA 14 % (histórico)' },
];

// ───────────────────────────── Montos ─────────────────────────────

const MONEY_INPUT = /^\d{1,10}(?:[.,]\d{1,2})?$/;

/**
 * Texto escrito por el usuario → "12.50". Acepta coma o punto decimal y como máximo 2 decimales;
 * devuelve null si no es un monto válido (negativo, 3 decimales, letras, vacío).
 */
export function parseMoney(text: string): string | null {
  const t = text.trim();
  if (!MONEY_INPUT.test(t)) return null;
  return centsToMoney(moneyToCents(t.replace(',', '.')));
}

/** "12.5" | 12.5 → 1250. Supone un monto válido (string del API o número). */
export function moneyToCents(value: Money): number {
  const s = typeof value === 'number' ? value.toFixed(2) : value.trim().replace(',', '.');
  const [int, dec = ''] = s.split('.');
  return Number(int) * 100 + Number(dec.padEnd(2, '0').slice(0, 2));
}

/** 1250 → "12.50". Los negativos se llevan a 0 (un precio nunca es negativo). */
export function centsToMoney(cents: number): string {
  const c = Math.max(0, Math.round(cents));
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

/** Normaliza un monto del API ("12.5", 12.5) a "12.50"; null se conserva. */
export function normalizeMoney(value: Money | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return centsToMoney(moneyToCents(value));
}

/** Mensaje de error de un campo de monto, o null si está bien. Vacío es válido si no es obligatorio. */
export function moneyError(text: string, required = false): string | null {
  if (!text.trim()) return required ? 'Obligatorio' : null;
  return parseMoney(text) === null ? 'Monto con máximo 2 decimales y sin signo (p. ej. 19.90)' : null;
}

/** Margen bruto (base − costo) / base como fracción (0.4 = 40 %); null si falta algún dato o base es 0. */
export function marginRatio(basePrice: string, cost: string): number | null {
  const b = parseMoney(basePrice);
  const c = parseMoney(cost);
  if (b === null || c === null) return null;
  const bc = moneyToCents(b);
  if (bc === 0) return null;
  return (bc - moneyToCents(c)) / bc;
}

/** El precio tachado (antes) debe ser mayor que el de venta; null = sin tachado. */
export function compareAtError(price: string | null, compareAt: string | null): string | null {
  if (price === null || compareAt === null) return null;
  return moneyToCents(compareAt) > moneyToCents(price) ? null : 'El precio tachado debe ser mayor que el precio de venta';
}

/** Validación de los precios del producto (textos del formulario). Devuelve errores por campo. */
export function validateProductPrices(v: { basePrice: string; compareAtPrice: string; cost: string }): Partial<Record<'basePrice' | 'compareAtPrice' | 'cost', string>> {
  const errors: Partial<Record<'basePrice' | 'compareAtPrice' | 'cost', string>> = {};
  const base = moneyError(v.basePrice, true);
  if (base) errors.basePrice = base;
  const cmp = moneyError(v.compareAtPrice);
  if (cmp) errors.compareAtPrice = cmp;
  const cost = moneyError(v.cost);
  if (cost) errors.cost = cost;
  if (!errors.basePrice && !errors.compareAtPrice) {
    const e = compareAtError(parseMoney(v.basePrice), v.compareAtPrice.trim() ? parseMoney(v.compareAtPrice) : null);
    if (e) errors.compareAtPrice = e;
  }
  return errors;
}

/**
 * 422 INVALID_PRICE al cambiar el precio base: variantes que heredan ese precio y quedarían con un
 * tachado ≤ al precio efectivo (rebaja falsa). Devuelve null si el error no trae ese detalle (p. ej.
 * el INVALID_PRICE del tachado del propio producto).
 */
export interface InheritedPriceConflict {
  productId: string;
  basePrice: string;
  variantIds: string[];
}

export function inheritedPriceConflict(details: Record<string, unknown> | null | undefined): InheritedPriceConflict | null {
  const ids = details?.variantIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === 'string')) return null;
  return { productId: String(details?.productId ?? ''), basePrice: String(details?.basePrice ?? ''), variantIds: ids as string[] };
}

// ───────────────────────────── Fotos ─────────────────────────────

/**
 * Mueve una foto una posición (dir −1 sube, +1 baja) y devuelve SOLO las fotos cuyo sortOrder
 * cambia, renumeradas 0..n−1 en el orden final (así se corrigen también órdenes repetidos).
 */
export function reorderMedia(media: readonly Pick<ProductMedia, 'id' | 'sortOrder'>[], id: string, dir: -1 | 1): { id: string; sortOrder: number }[] {
  const list = [...media].sort((a, b) => a.sortOrder - b.sortOrder);
  const i = list.findIndex((m) => m.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return [];
  [list[i], list[j]] = [list[j], list[i]];
  return list.flatMap((m, idx) => (m.sortOrder === idx ? [] : [{ id: m.id, sortOrder: idx }]));
}

// ───────────────────────────── Slug y SKU ─────────────────────────────

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** "Vestido Floral Año 2026!" → "vestido-floral-ano-2026" (mismas reglas que el API). */
export function slugify(text: string, maxLength = SLUG_MAX_LENGTH): string {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

export function slugError(slug: string): string | null {
  if (!slug) return null;
  if (slug.length > SLUG_MAX_LENGTH) return `Máximo ${SLUG_MAX_LENGTH} caracteres`;
  return SLUG_RE.test(slug) ? null : 'Solo minúsculas, números y guiones (p. ej. vestido-floral)';
}

function skuPart(text: string): string {
  return stripAccents(text)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * SKU sugerido SLUG-COLOR-TALLA en mayúsculas y sin tildes: ("vestido-floral", "Azul Marino", "M")
 * → "VESTIDO-FLORAL-AZUL-MARINO-M". Se omiten las partes vacías y se recorta a 64 caracteres.
 */
export function suggestSku(slug: string, color?: string | null, size?: string | null): string {
  const parts = [slug, color ?? '', size ?? ''].map(skuPart).filter(Boolean);
  const sku = parts.join('-').slice(0, 64).replace(/-+$/g, '');
  return sku || 'SKU';
}

export function skuError(sku: string): string | null {
  if (!sku.trim()) return 'Obligatorio';
  return SKU_RE.test(sku.trim()) ? null : 'Letras, números, ".", "_", "/" o "-" (máx. 64)';
}

export function barcodeError(barcode: string): string | null {
  if (!barcode.trim()) return null;
  return BARCODE_RE.test(barcode.trim()) ? null : 'De 4 a 64 letras, números o "-"';
}

// ───────────────────────────── Lookups ─────────────────────────────

/** Categorías como opciones "Mujer › Vestidos" (nombres de la ruta), ordenadas por esa etiqueta. */
export function categoryOptions(categories: readonly Category[]): { id: string; label: string; active: boolean }[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const label = (c: Category): string => {
    const names: string[] = [];
    let cur: Category | undefined = c;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      names.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return names.join(' › ');
  };
  return categories
    .map((c) => ({ id: c.id, label: label(c), active: c.active }))
    .sort((a, b) => a.label.localeCompare(b.label, 'es'));
}

/** Tallas ordenadas por sistema y orden (S, M, L… y no alfabético). */
export function sortSizes(sizes: readonly Size[]): Size[] {
  return [...sizes].sort(
    (a, b) => SIZE_SYSTEMS.indexOf(a.sizeSystem) - SIZE_SYSTEMS.indexOf(b.sizeSystem) || a.sortOrder - b.sortOrder || a.code.localeCompare(b.code, 'es'),
  );
}

// ───────────────────────────── Matriz de variantes ─────────────────────────────

export interface MatrixCombination {
  colorId: string;
  sizeId: string;
  sku: string;
}

/**
 * Combinaciones color × talla que el producto todavía no tiene, con su SKU sugerido. Si el SKU
 * sugerido choca con uno existente o repetido en el lote, se le agrega -2, -3…
 */
export function missingCombinations(
  slug: string,
  existing: readonly Pick<AdminVariant, 'sku' | 'color' | 'size'>[],
  colors: readonly Color[],
  sizes: readonly Size[],
): MatrixCombination[] {
  const have = new Set(existing.map((v) => `${v.color?.id ?? ''}|${v.size?.id ?? ''}`));
  const skus = new Set(existing.map((v) => v.sku.toUpperCase()));
  const out: MatrixCombination[] = [];
  for (const c of colors) {
    for (const s of sizes) {
      if (have.has(`${c.id}|${s.id}`)) continue;
      const base = suggestSku(slug, c.name, s.code);
      let sku = base;
      for (let n = 2; skus.has(sku.toUpperCase()); n++) sku = `${base.slice(0, 60)}-${n}`;
      skus.add(sku.toUpperCase());
      out.push({ colorId: c.id, sizeId: s.id, sku });
    }
  }
  return out;
}

// ───────────────────────────── Formulario de producto ─────────────────────────────

/** Valores del formulario de producto (todo texto, tal como lo edita el usuario). */
export interface ProductFormValues {
  name: string;
  slug: string;
  description: string;
  categoryId: string;
  brandId: string;
  sizeChartId: string;
  gender: Gender | '';
  season: string;
  material: string;
  careInstructions: string;
  basePrice: string;
  compareAtPrice: string;
  cost: string;
  taxCode: string;
  status: ProductStatus;
}

export const EMPTY_PRODUCT_FORM: ProductFormValues = {
  name: '',
  slug: '',
  description: '',
  categoryId: '',
  brandId: '',
  sizeChartId: '',
  gender: '',
  season: '',
  material: '',
  careInstructions: '',
  basePrice: '',
  compareAtPrice: '',
  cost: '',
  taxCode: DEFAULT_TAX_CODE,
  status: 'draft',
};

export function productToForm(p: AdminProductDetail): ProductFormValues {
  return {
    name: p.name,
    slug: p.slug,
    description: p.description ?? '',
    categoryId: p.categoryId,
    brandId: p.brandId ?? '',
    sizeChartId: p.sizeChartId ?? '',
    gender: p.gender,
    season: p.season ?? '',
    material: p.material ?? '',
    careInstructions: p.careInstructions ?? '',
    basePrice: normalizeMoney(p.basePrice) ?? '',
    compareAtPrice: normalizeMoney(p.compareAtPrice) ?? '',
    cost: normalizeMoney(p.cost) ?? '',
    taxCode: p.taxCode,
    status: p.status,
  };
}

export type ProductFormErrors = Partial<Record<keyof ProductFormValues, string>>;

export function validateProductForm(v: ProductFormValues): ProductFormErrors {
  const errors: ProductFormErrors = { ...validateProductPrices(v) };
  const name = v.name.trim();
  if (name.length < 2) errors.name = 'Mínimo 2 caracteres';
  else if (name.length > 200) errors.name = 'Máximo 200 caracteres';
  const slug = slugError(v.slug.trim());
  if (slug) errors.slug = slug;
  if (!v.categoryId) errors.categoryId = 'Elige una categoría';
  if (!v.gender) errors.gender = 'Elige el género';
  if (!/^\d{1,4}$/.test(v.taxCode)) errors.taxCode = 'Código de IVA inválido';
  return errors;
}

type ProductBody = Record<string, string | null>;

const OPTIONAL_TEXT: readonly (keyof ProductFormValues)[] = ['description', 'brandId', 'sizeChartId', 'season', 'material', 'careInstructions'];

/** Valor de un campo tal como lo espera el API (texto vacío → null; montos "12.50"). */
function fieldToApi(k: keyof ProductFormValues, v: ProductFormValues): string | null {
  const raw = v[k];
  if (k === 'basePrice') return parseMoney(raw) ?? raw;
  if (k === 'compareAtPrice' || k === 'cost') return raw.trim() ? (parseMoney(raw) ?? raw) : null;
  if (k === 'name' || k === 'slug') return raw.trim();
  if (OPTIONAL_TEXT.includes(k)) return raw.trim() || null;
  return raw;
}

/** Cuerpo de POST /catalog/admin/products. El slug vacío se omite (el API lo genera). */
export function createProductBody(v: ProductFormValues): ProductBody {
  const body: ProductBody = {};
  for (const k of Object.keys(v) as (keyof ProductFormValues)[]) {
    const val = fieldToApi(k, v);
    if (val === null || val === '') continue;
    body[k] = val;
  }
  return body;
}

/**
 * Cuerpo de PATCH /catalog/admin/products/:id: SOLO los campos que el usuario cambió respecto de
 * lo que leyó (base), así no pisa campos que otro haya editado. null limpia un campo opcional.
 */
export function updateProductBody(base: ProductFormValues, current: ProductFormValues, expectedUpdatedAt: string): ProductBody & { expectedUpdatedAt: string } {
  const body: ProductBody = {};
  for (const k of Object.keys(current) as (keyof ProductFormValues)[]) {
    const before = fieldToApi(k, base);
    const after = fieldToApi(k, current);
    if (before !== after) body[k] = after;
  }
  return { ...body, expectedUpdatedAt };
}

export function isFormDirty(base: ProductFormValues, current: ProductFormValues): boolean {
  return (Object.keys(current) as (keyof ProductFormValues)[]).some((k) => fieldToApi(k, base) !== fieldToApi(k, current));
}

/**
 * Tras un 409 STALE_PRODUCT: se recargan los datos del servidor sin perder lo tecleado. Los campos
 * que el usuario cambió (current ≠ base) se conservan; los demás toman el valor nuevo del servidor.
 */
export function mergeAfterReload(base: ProductFormValues, server: ProductFormValues, current: ProductFormValues): ProductFormValues {
  const out = { ...server };
  for (const k of Object.keys(current) as (keyof ProductFormValues)[]) {
    if (fieldToApi(k, current) !== fieldToApi(k, base)) (out as Record<string, string>)[k] = current[k];
  }
  return out;
}

// ───────────────────────────── Variantes ─────────────────────────────

export interface VariantFormValues {
  sku: string;
  barcode: string;
  colorId: string;
  sizeId: string;
  /** Vacío = hereda el precio del producto. */
  price: string;
  compareAtPrice: string;
  weightG: string;
  status: VariantStatus;
}

export function variantToForm(v: AdminVariant): VariantFormValues {
  return {
    sku: v.sku,
    barcode: v.barcode ?? '',
    colorId: v.color?.id ?? '',
    sizeId: v.size?.id ?? '',
    price: normalizeMoney(v.price) ?? '',
    compareAtPrice: normalizeMoney(v.compareAtPrice) ?? '',
    weightG: String(v.weightG),
    status: v.status,
  };
}

export function emptyVariantForm(): VariantFormValues {
  return { sku: '', barcode: '', colorId: '', sizeId: '', price: '', compareAtPrice: '', weightG: String(DEFAULT_WEIGHT_G), status: 'active' };
}

export type VariantFormErrors = Partial<Record<keyof VariantFormValues, string>>;

/** Valida una variante; productBasePrice es el precio que hereda si no tiene uno propio. */
export function validateVariantForm(v: VariantFormValues, productBasePrice: Money): VariantFormErrors {
  const errors: VariantFormErrors = {};
  const sku = skuError(v.sku);
  if (sku) errors.sku = sku;
  const bc = barcodeError(v.barcode);
  if (bc) errors.barcode = bc;
  const price = moneyError(v.price);
  if (price) errors.price = price;
  const cmp = moneyError(v.compareAtPrice);
  if (cmp) errors.compareAtPrice = cmp;
  if (!errors.price && !errors.compareAtPrice && v.compareAtPrice.trim()) {
    const effective = v.price.trim() ? parseMoney(v.price) : normalizeMoney(productBasePrice);
    const e = compareAtError(effective, parseMoney(v.compareAtPrice));
    if (e) errors.compareAtPrice = e;
  }
  const w = Number(v.weightG);
  if (!/^\d+$/.test(v.weightG.trim()) || w < 1 || w > 100_000) errors.weightG = 'Gramos entre 1 y 100000';
  return errors;
}

type VariantBody = Record<string, string | number | null>;

function variantFieldToApi(k: keyof VariantFormValues, v: VariantFormValues): string | number | null {
  const raw = v[k].trim();
  if (k === 'price' || k === 'compareAtPrice') return raw ? (parseMoney(raw) ?? raw) : null;
  if (k === 'weightG') return Number(raw);
  if (k === 'barcode' || k === 'colorId' || k === 'sizeId') return raw || null;
  return raw;
}

/** Cuerpo de POST /catalog/admin/products/:id/variants (sin los campos vacíos). */
export function createVariantBody(v: VariantFormValues): VariantBody {
  const body: VariantBody = {};
  for (const k of Object.keys(v) as (keyof VariantFormValues)[]) {
    const val = variantFieldToApi(k, v);
    if (val !== null && val !== '') body[k] = val;
  }
  return body;
}

/** Cuerpo de PATCH /catalog/admin/variants/:id con solo lo que cambió (null = limpiar / heredar). */
export function updateVariantBody(base: VariantFormValues, current: VariantFormValues): VariantBody {
  const body: VariantBody = {};
  for (const k of Object.keys(current) as (keyof VariantFormValues)[]) {
    const after = variantFieldToApi(k, current);
    if (variantFieldToApi(k, base) !== after) body[k] = after;
  }
  return body;
}

// ───────────────────────────── Precios masivos ─────────────────────────────

/** Par precio / tachado normalizado ("12.50" o null). */
export interface PricePair {
  price: string | null;
  compareAtPrice: string | null;
}

export type PriceTool =
  | { kind: 'set'; value: string }
  | { kind: 'percent'; percent: number }
  | { kind: 'discount'; percent: number }
  | { kind: 'setCompareAt'; value: string }
  | { kind: 'clearCompareAt' };

/** Redondea al centavo (mitad hacia arriba) un monto multiplicado por (1 + percent/100). */
export function applyPercent(cents: number, percent: number): number {
  const factorBp = 10_000 + Math.round(percent * 100);
  return Math.max(0, Math.round((cents * factorBp) / 10_000));
}

/**
 * Aplica una herramienta a un precio. `inherited` es el precio que se usa como referencia cuando la
 * fila no tiene precio propio (variante que hereda): un cálculo sobre ella le fija precio propio.
 *
 * - set: fija el precio.
 * - percent: sube (+) o baja (−) el precio un %.
 * - discount: rebaja un % y deja como tachado el precio anterior (o conserva el tachado que ya
 *   tenía, que es el precio "original" de una rebaja previa).
 * - setCompareAt / clearCompareAt: pone o quita el tachado.
 */
export function applyPriceTool(current: PricePair, tool: PriceTool, inherited: string | null = null): PricePair {
  const ref = current.price ?? inherited;
  switch (tool.kind) {
    case 'set':
      return { ...current, price: parseMoney(tool.value) ?? current.price };
    case 'percent':
      return ref === null ? current : { ...current, price: centsToMoney(applyPercent(moneyToCents(ref), tool.percent)) };
    case 'discount':
      if (ref === null) return current;
      return { price: centsToMoney(applyPercent(moneyToCents(ref), -Math.abs(tool.percent))), compareAtPrice: current.compareAtPrice ?? ref };
    case 'setCompareAt':
      return { ...current, compareAtPrice: parseMoney(tool.value) ?? current.compareAtPrice };
    case 'clearCompareAt':
      return { ...current, compareAtPrice: null };
  }
}

export function samePair(a: PricePair, b: PricePair): boolean {
  return a.price === b.price && a.compareAtPrice === b.compareAtPrice;
}

/** Cambio pendiente de un producto (precio = basePrice; nunca null). */
export interface ProductPriceDraft {
  kind: 'product';
  id: string;
  label: string;
  before: PricePair;
  after: PricePair;
}

/** Cambio pendiente de una variante (precio null = hereda el del producto). */
export interface VariantPriceDraft {
  kind: 'variant';
  id: string;
  productId: string;
  label: string;
  /** Precio base del producto al leerlo (para validar el tachado de una variante que hereda). */
  productBasePrice: string;
  before: PricePair;
  after: PricePair;
}

export type PriceDraft = ProductPriceDraft | VariantPriceDraft;

/** Error de una fila pendiente (precio de producto obligatorio y tachado > precio efectivo). */
export function draftError(d: PriceDraft, productDrafts: ReadonlyMap<string, ProductPriceDraft>): string | null {
  if (d.kind === 'product') {
    if (d.after.price === null) return 'El precio base es obligatorio';
    return compareAtError(d.after.price, d.after.compareAtPrice);
  }
  const base = productDrafts.get(d.productId)?.after.price ?? d.productBasePrice;
  return compareAtError(d.after.price ?? base, d.after.compareAtPrice);
}

function productRow(d: ProductPriceDraft): ProductPriceRow | null {
  const row: ProductPriceRow = { id: d.id };
  if (d.after.price !== d.before.price && d.after.price !== null) row.basePrice = d.after.price;
  if (d.after.compareAtPrice !== d.before.compareAtPrice) row.compareAtPrice = d.after.compareAtPrice;
  return Object.keys(row).length > 1 ? row : null;
}

function variantRow(d: VariantPriceDraft): VariantPriceRow | null {
  const row: VariantPriceRow = { id: d.id };
  if (d.after.price !== d.before.price) row.price = d.after.price;
  if (d.after.compareAtPrice !== d.before.compareAtPrice) row.compareAtPrice = d.after.compareAtPrice;
  return Object.keys(row).length > 1 ? row : null;
}

export interface PriceBatch {
  body: BulkPricesBody;
  /** Ids (productos y variantes) que viajan en este lote. */
  ids: string[];
}

/**
 * Parte los cambios en lotes de ≤ max filas para PATCH /catalog/admin/prices. Un producto y sus
 * variantes viajan juntos (el tachado de una variante que hereda se valida con el precio nuevo del
 * producto); si un grupo no cabe solo, se parte con el producto primero.
 */
export function buildPriceBatches(drafts: readonly PriceDraft[], max = MAX_PRICE_ROWS): PriceBatch[] {
  type Row = { kind: 'product'; row: ProductPriceRow } | { kind: 'variant'; row: VariantPriceRow };
  const groups = new Map<string, Row[]>();
  const add = (key: string, r: Row, first = false) => {
    const g = groups.get(key) ?? [];
    if (first) g.unshift(r);
    else g.push(r);
    groups.set(key, g);
  };
  for (const d of drafts) {
    if (d.kind === 'product') {
      const row = productRow(d);
      if (row) add(d.id, { kind: 'product', row }, true);
    } else {
      const row = variantRow(d);
      if (row) add(d.productId, { kind: 'variant', row });
    }
  }

  const batches: Row[][] = [];
  let cur: Row[] = [];
  for (const g of groups.values()) {
    if (cur.length + g.length > max && cur.length > 0) {
      batches.push(cur);
      cur = [];
    }
    for (const r of g) {
      if (cur.length === max) {
        batches.push(cur);
        cur = [];
      }
      cur.push(r);
    }
  }
  if (cur.length) batches.push(cur);

  return batches.map((rows) => ({
    body: {
      products: rows.flatMap((r) => (r.kind === 'product' ? [r.row] : [])),
      variants: rows.flatMap((r) => (r.kind === 'variant' ? [r.row] : [])),
    },
    ids: rows.map((r) => r.row.id),
  }));
}
