import { Injectable } from '@nestjs/common';
import { DatabaseError } from 'pg';
import { buildSetClause, isUniqueViolation, Queryable } from '../../../shared-kernel';
import {
  AdminProductDetail,
  AdminProductListItem,
  AdminProductListQuery,
  AdminVariant,
  CatalogAdminRepository,
  Lookups,
  MediaRecord,
  ProductRecord,
  ReferenceIds,
  VariantFields,
  VariantLookupItem,
  VariantRecord,
} from '../application/admin-ports';
import {
  BarcodeTakenError,
  LookupTakenError,
  ProductFields,
  SizeSystem,
  SkuTakenError,
  SlugTakenError,
  VariantDuplicateError,
} from '../domain/admin-catalog';
import { mediaUrl } from '../domain/storefront';

const PRODUCT_COLUMNS: Record<keyof ProductFields, string> = {
  name: 'name',
  slug: 'slug',
  description: 'description',
  categoryId: 'category_id',
  brandId: 'brand_id',
  sizeChartId: 'size_chart_id',
  gender: 'gender',
  season: 'season',
  material: 'material',
  careInstructions: 'care_instructions',
  basePrice: 'base_price',
  compareAtPrice: 'compare_at_price',
  cost: 'cost',
  taxCode: 'tax_code',
  status: 'status',
};

const VARIANT_COLUMNS: Record<keyof VariantFields, string> = {
  sku: 'sku',
  barcode: 'barcode',
  colorId: 'color_id',
  sizeId: 'size_id',
  price: 'price',
  compareAtPrice: 'compare_at_price',
  weightG: 'weight_g',
  status: 'status',
};

/**
 * updated_at avanza al menos 1 ms en cada cambio: el token de concurrencia viaja con precisión de
 * milisegundos (JSON), así dos guardados seguidos nunca devuelven el mismo valor.
 */
const BUMP_UPDATED_AT = `updated_at = GREATEST(now(), updated_at + interval '1 millisecond')`;

const PRODUCT_SELECT = `
  p.id, p.name, p.slug, p.description, p.category_id, p.brand_id, p.size_chart_id, p.gender, p.season,
  p.material, p.care_instructions, p.base_price, p.compare_at_price, p.cost, p.tax_code, p.status,
  p.published_at, p.created_at, p.updated_at`;

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category_id: string;
  brand_id: string | null;
  size_chart_id: string | null;
  gender: ProductFields['gender'];
  season: string | null;
  material: string | null;
  care_instructions: string | null;
  base_price: string;
  compare_at_price: string | null;
  cost: string | null;
  tax_code: string;
  status: ProductFields['status'];
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toProductRecord(r: ProductRow): ProductRecord {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    categoryId: r.category_id,
    brandId: r.brand_id,
    sizeChartId: r.size_chart_id,
    gender: r.gender,
    season: r.season,
    material: r.material,
    careInstructions: r.care_instructions,
    basePrice: r.base_price,
    compareAtPrice: r.compare_at_price,
    cost: r.cost,
    taxCode: r.tax_code,
    status: r.status,
    publishedAt: r.published_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const VARIANT_VIEW_SELECT = `
  v.id, v.sku, v.barcode, v.price, v.compare_at_price, v.weight_g, v.status,
  COALESCE(v.price, p.base_price) AS effective_price,
  co.id AS color_id, co.name AS color_name, co.hex AS color_hex, s.id AS size_id, s.code AS size_code`;

interface VariantViewRow {
  id: string;
  sku: string;
  barcode: string | null;
  price: string | null;
  compare_at_price: string | null;
  weight_g: number;
  status: AdminVariant['status'];
  effective_price: string;
  color_id: string | null;
  color_name: string | null;
  color_hex: string | null;
  size_id: string | null;
  size_code: string | null;
}

function toVariantView(r: VariantViewRow): AdminVariant {
  return {
    id: r.id,
    sku: r.sku,
    barcode: r.barcode,
    color: r.color_id ? { id: r.color_id, name: r.color_name!, hex: r.color_hex } : null,
    size: r.size_id ? { id: r.size_id, code: r.size_code! } : null,
    price: r.price,
    compareAtPrice: r.compare_at_price,
    effectivePrice: r.effective_price,
    weightG: r.weight_g,
    status: r.status,
  };
}

/** Escapa los comodines de LIKE para buscar el texto tal cual. */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Traduce las restricciones UNIQUE de product_variants a errores de negocio. */
function variantUniqueError(error: unknown, fields: Partial<VariantFields>): Error | null {
  if (!isUniqueViolation(error)) return null;
  const constraint = (error as DatabaseError).constraint ?? '';
  if (constraint.includes('barcode')) return new BarcodeTakenError(fields.barcode ?? '');
  if (constraint.includes('sku')) return new SkuTakenError(fields.sku ?? '');
  return new VariantDuplicateError();
}

@Injectable()
export class PgCatalogAdminRepository extends CatalogAdminRepository {
  async listProducts(q: Queryable, tenantId: string, query: AdminProductListQuery): Promise<{ items: AdminProductListItem[]; total: number }> {
    const values: unknown[] = [tenantId];
    const where = ['p.tenant_id = $1', 'p.deleted_at IS NULL'];
    if (query.status) {
      values.push(query.status);
      where.push(`p.status = $${values.length}`);
    }
    if (query.categoryId) {
      values.push(query.categoryId);
      where.push(`p.category_id = $${values.length}`);
    }
    if (query.brandId) {
      values.push(query.brandId);
      where.push(`p.brand_id = $${values.length}`);
    }
    if (query.q && query.q.trim()) {
      values.push(`%${likeEscape(query.q.trim())}%`);
      const n = values.length;
      where.push(`(p.name ILIKE $${n} OR p.slug ILIKE $${n}
                   OR EXISTS (SELECT 1 FROM catalog.product_variants sv
                               WHERE sv.product_id = p.id AND (sv.sku ILIKE $${n} OR sv.barcode ILIKE $${n})))`);
    }
    values.push(query.limit, query.offset);
    const { rows } = await q.query<{
      id: string;
      name: string;
      slug: string;
      status: AdminProductListItem['status'];
      brand_id: string | null;
      brand_name: string | null;
      category_id: string;
      category_name: string;
      category_path: string;
      gender: string;
      base_price: string;
      compare_at_price: string | null;
      cost: string | null;
      variant_count: number;
      updated_at: Date;
      total: string;
    }>(
      `SELECT p.id, p.name, p.slug, p.status, b.id AS brand_id, b.name AS brand_name,
              c.id AS category_id, c.name AS category_name, c.path AS category_path, p.gender,
              p.base_price, p.compare_at_price, p.cost, p.updated_at,
              (SELECT count(*)::int FROM catalog.product_variants v WHERE v.product_id = p.id) AS variant_count,
              count(*) OVER () AS total
         FROM catalog.products p
         JOIN catalog.categories c ON c.id = p.category_id
         LEFT JOIN catalog.brands b ON b.id = p.brand_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.updated_at DESC, p.id
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    let total = rows.length > 0 ? Number(rows[0].total) : 0;
    if (rows.length === 0 && query.offset > 0) {
      // Página fuera de rango: el total igual sirve para el paginador.
      const c = await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM catalog.products p WHERE ${where.join(' AND ')}`,
        values.slice(0, values.length - 2),
      );
      total = c.rows[0].n;
    }
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        brand: r.brand_id ? { id: r.brand_id, name: r.brand_name! } : null,
        category: { id: r.category_id, name: r.category_name, path: r.category_path },
        gender: r.gender,
        basePrice: r.base_price,
        compareAtPrice: r.compare_at_price,
        cost: r.cost,
        variantCount: r.variant_count,
        updatedAt: r.updated_at.toISOString(),
      })),
    };
  }

  async findProduct(q: Queryable, tenantId: string, id: string, forUpdate = false): Promise<ProductRecord | null> {
    const { rows } = await q.query<ProductRow>(
      `SELECT ${PRODUCT_SELECT} FROM catalog.products p
        WHERE p.tenant_id = $1 AND p.id = $2 AND p.deleted_at IS NULL ${forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, id],
    );
    return rows[0] ? toProductRecord(rows[0]) : null;
  }

  async productDetail(q: Queryable, tenantId: string, id: string, mediaBaseUrl: string): Promise<AdminProductDetail | null> {
    const { rows } = await q.query<ProductRow & { brand_name: string | null; category_name: string; category_path: string }>(
      `SELECT ${PRODUCT_SELECT}, b.name AS brand_name, c.name AS category_name, c.path AS category_path
         FROM catalog.products p
         JOIN catalog.categories c ON c.id = p.category_id
         LEFT JOIN catalog.brands b ON b.id = p.brand_id
        WHERE p.tenant_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
      [tenantId, id],
    );
    const r = rows[0];
    if (!r) return null;
    const [variants, media] = [
      await q.query<VariantViewRow>(
        `SELECT ${VARIANT_VIEW_SELECT}
           FROM catalog.product_variants v
           JOIN catalog.products p ON p.id = v.product_id
           LEFT JOIN catalog.colors co ON co.id = v.color_id
           LEFT JOIN catalog.sizes s ON s.id = v.size_id
          WHERE v.product_id = $1
          ORDER BY co.name NULLS FIRST, s.sort_order NULLS FIRST, v.sku`,
        [id],
      ),
      await q.query<{ id: string; storage_key: string; color_id: string | null; sort_order: number; alt_text: string | null }>(
        `SELECT id, storage_key, color_id, sort_order, alt_text FROM catalog.product_media
          WHERE product_id = $1 ORDER BY sort_order, id`,
        [id],
      ),
    ];
    return {
      ...toProductRecord(r),
      brand: r.brand_id ? { id: r.brand_id, name: r.brand_name! } : null,
      category: { id: r.category_id, name: r.category_name, path: r.category_path },
      variants: variants.rows.map(toVariantView),
      media: media.rows.map((m) => ({ id: m.id, url: mediaUrl(mediaBaseUrl, m.storage_key), colorId: m.color_id, sortOrder: m.sort_order, altText: m.alt_text })),
    };
  }

  async slugsLike(q: Queryable, tenantId: string, base: string): Promise<string[]> {
    const { rows } = await q.query<{ slug: string }>(
      `SELECT slug FROM catalog.products WHERE tenant_id = $1 AND (slug = $2 OR slug LIKE $3 ESCAPE '\\')`,
      [tenantId, base, `${likeEscape(base)}-%`],
    );
    return rows.map((r) => r.slug);
  }

  async slugExists(q: Queryable, tenantId: string, slug: string, exceptId?: string): Promise<boolean> {
    const { rowCount } = await q.query(
      `SELECT 1 FROM catalog.products WHERE tenant_id = $1 AND slug = $2 AND ($3::uuid IS NULL OR id <> $3)`,
      [tenantId, slug, exceptId ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async missingReferences(q: Queryable, tenantId: string, refs: ReferenceIds): Promise<string[]> {
    const checks: [string, string, string | null | undefined][] = [
      ['categoryId', 'catalog.categories', refs.categoryId],
      ['brandId', 'catalog.brands', refs.brandId],
      ['sizeChartId', 'catalog.size_charts', refs.sizeChartId],
      ['colorId', 'catalog.colors', refs.colorId],
      ['sizeId', 'catalog.sizes', refs.sizeId],
    ];
    const missing: string[] = [];
    for (const [field, table, id] of checks) {
      if (!id) continue;
      const { rowCount } = await q.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      if (!rowCount) missing.push(field);
    }
    return missing;
  }

  async insertProduct(q: Queryable, tenantId: string, f: ProductFields): Promise<string> {
    try {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO catalog.products
           (tenant_id, name, slug, description, category_id, brand_id, size_chart_id, gender, season, material,
            care_instructions, base_price, compare_at_price, cost, tax_code, status, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                 CASE WHEN $16 = 'active' THEN now() END)
         RETURNING id`,
        [
          tenantId,
          f.name,
          f.slug,
          f.description,
          f.categoryId,
          f.brandId,
          f.sizeChartId,
          f.gender,
          f.season,
          f.material,
          f.careInstructions,
          f.basePrice,
          f.compareAtPrice,
          f.cost,
          f.taxCode,
          f.status,
        ],
      );
      return rows[0].id;
    } catch (error) {
      if (isUniqueViolation(error)) throw new SlugTakenError(f.slug);
      throw error;
    }
  }

  async updateProduct(q: Queryable, tenantId: string, id: string, patch: Partial<ProductFields>): Promise<void> {
    const set = buildSetClause(patch, PRODUCT_COLUMNS, 3);
    const published = patch.status === 'active' ? `, published_at = COALESCE(published_at, now())` : '';
    try {
      await q.query(
        `UPDATE catalog.products SET ${set.sql ? `${set.sql}, ` : ''}${BUMP_UPDATED_AT}${published}
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id, ...set.values],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new SlugTakenError(patch.slug ?? '');
      throw error;
    }
  }

  async findVariant(q: Queryable, tenantId: string, id: string, forUpdate = false): Promise<VariantRecord | null> {
    const { rows } = await q.query<{
      id: string;
      product_id: string;
      sku: string;
      barcode: string | null;
      color_id: string | null;
      size_id: string | null;
      price: string | null;
      compare_at_price: string | null;
      weight_g: number;
      status: VariantFields['status'];
      base_price: string;
    }>(
      `SELECT v.id, v.product_id, v.sku, v.barcode, v.color_id, v.size_id, v.price, v.compare_at_price,
              v.weight_g, v.status, p.base_price
         FROM catalog.product_variants v
         JOIN catalog.products p ON p.id = v.product_id
        WHERE p.tenant_id = $1 AND v.id = $2 AND p.deleted_at IS NULL
        ${forUpdate ? 'FOR UPDATE OF v' : ''}`,
      [tenantId, id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      productId: r.product_id,
      sku: r.sku,
      barcode: r.barcode,
      colorId: r.color_id,
      sizeId: r.size_id,
      price: r.price,
      compareAtPrice: r.compare_at_price,
      weightG: r.weight_g,
      status: r.status,
      productBasePrice: r.base_price,
    };
  }

  async skuExists(q: Queryable, sku: string, exceptId?: string): Promise<boolean> {
    const { rowCount } = await q.query(`SELECT 1 FROM catalog.product_variants WHERE sku = $1 AND ($2::uuid IS NULL OR id <> $2)`, [sku, exceptId ?? null]);
    return (rowCount ?? 0) > 0;
  }

  async barcodeExists(q: Queryable, barcode: string, exceptId?: string): Promise<boolean> {
    const { rowCount } = await q.query(`SELECT 1 FROM catalog.product_variants WHERE barcode = $1 AND ($2::uuid IS NULL OR id <> $2)`, [
      barcode,
      exceptId ?? null,
    ]);
    return (rowCount ?? 0) > 0;
  }

  async comboExists(q: Queryable, productId: string, colorId: string | null, sizeId: string | null, exceptId?: string): Promise<boolean> {
    const { rowCount } = await q.query(
      `SELECT 1 FROM catalog.product_variants
        WHERE product_id = $1 AND color_id IS NOT DISTINCT FROM $2::uuid AND size_id IS NOT DISTINCT FROM $3::uuid
          AND ($4::uuid IS NULL OR id <> $4)`,
      [productId, colorId, sizeId, exceptId ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async insertVariant(q: Queryable, productId: string, f: VariantFields): Promise<string> {
    try {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO catalog.product_variants (product_id, sku, barcode, color_id, size_id, price, compare_at_price, weight_g, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [productId, f.sku, f.barcode, f.colorId, f.sizeId, f.price, f.compareAtPrice, f.weightG, f.status],
      );
      return rows[0].id;
    } catch (error) {
      throw variantUniqueError(error, f) ?? error;
    }
  }

  async updateVariant(q: Queryable, id: string, patch: Partial<VariantFields>): Promise<void> {
    const set = buildSetClause(patch, VARIANT_COLUMNS, 2);
    try {
      await q.query(`UPDATE catalog.product_variants SET ${set.sql}, updated_at = now() WHERE id = $1`, [id, ...set.values]);
    } catch (error) {
      throw variantUniqueError(error, patch) ?? error;
    }
  }

  async variantView(q: Queryable, tenantId: string, id: string): Promise<AdminVariant | null> {
    const { rows } = await q.query<VariantViewRow>(
      `SELECT ${VARIANT_VIEW_SELECT}
         FROM catalog.product_variants v
         JOIN catalog.products p ON p.id = v.product_id
         LEFT JOIN catalog.colors co ON co.id = v.color_id
         LEFT JOIN catalog.sizes s ON s.id = v.size_id
        WHERE p.tenant_id = $1 AND v.id = $2`,
      [tenantId, id],
    );
    return rows[0] ? toVariantView(rows[0]) : null;
  }

  async lockProductPrices(q: Queryable, tenantId: string, ids: string[]) {
    if (ids.length === 0) return [];
    // Orden fijo de bloqueo (por id): dos cambios masivos simultáneos no se bloquean en cruz.
    const { rows } = await q.query<{ id: string; base_price: string; compare_at_price: string | null }>(
      `SELECT id, base_price, compare_at_price FROM catalog.products
        WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL
        ORDER BY id FOR UPDATE`,
      [tenantId, ids],
    );
    return rows.map((r) => ({ id: r.id, basePrice: r.base_price, compareAtPrice: r.compare_at_price }));
  }

  async lockVariantPrices(q: Queryable, tenantId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const { rows } = await q.query<{ id: string; product_id: string; price: string | null; compare_at_price: string | null }>(
      `SELECT v.id, v.product_id, v.price, v.compare_at_price
         FROM catalog.product_variants v
         JOIN catalog.products p ON p.id = v.product_id
        WHERE p.tenant_id = $1 AND v.id = ANY($2::uuid[]) AND p.deleted_at IS NULL
        ORDER BY v.id FOR UPDATE OF v`,
      [tenantId, ids],
    );
    return rows.map((r) => ({ id: r.id, productId: r.product_id, price: r.price, compareAtPrice: r.compare_at_price }));
  }

  async setProductPrices(q: Queryable, id: string, basePrice: string, compareAtPrice: string | null): Promise<void> {
    await q.query(`UPDATE catalog.products SET base_price = $2, compare_at_price = $3, ${BUMP_UPDATED_AT} WHERE id = $1`, [id, basePrice, compareAtPrice]);
  }

  async setVariantPrices(q: Queryable, id: string, price: string | null, compareAtPrice: string | null): Promise<void> {
    await q.query(`UPDATE catalog.product_variants SET price = $2, compare_at_price = $3, updated_at = now() WHERE id = $1`, [id, price, compareAtPrice]);
  }

  async productPrices(q: Queryable, ids: string[]) {
    if (ids.length === 0) return new Map();
    const { rows } = await q.query<{ id: string; base_price: string; compare_at_price: string | null }>(
      `SELECT id, base_price, compare_at_price FROM catalog.products WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(rows.map((r) => [r.id, { basePrice: r.base_price, compareAtPrice: r.compare_at_price }]));
  }

  async inheritingVariantsWithCompareAt(q: Queryable, productIds: string[]) {
    if (productIds.length === 0) return [];
    const { rows } = await q.query<{ id: string; product_id: string; price: string | null; compare_at_price: string | null }>(
      `SELECT id, product_id, price, compare_at_price FROM catalog.product_variants
        WHERE product_id = ANY($1::uuid[]) AND price IS NULL AND compare_at_price IS NOT NULL
        ORDER BY id`,
      [productIds],
    );
    return rows.map((r) => ({ id: r.id, productId: r.product_id, price: r.price, compareAtPrice: r.compare_at_price }));
  }

  async lookups(q: Queryable, tenantId: string): Promise<Lookups> {
    const [brands, categories, colors, sizes, sizeCharts] = [
      await q.query(`SELECT id, name, slug, active FROM catalog.brands WHERE tenant_id = $1 ORDER BY name`, [tenantId]),
      await q.query(
        `SELECT id, parent_id AS "parentId", name, slug, path, active FROM catalog.categories WHERE tenant_id = $1 ORDER BY path`,
        [tenantId],
      ),
      await q.query(`SELECT id, name, hex FROM catalog.colors WHERE tenant_id = $1 ORDER BY name`, [tenantId]),
      await q.query(
        `SELECT id, code, size_system AS "sizeSystem", sort_order AS "sortOrder" FROM catalog.sizes
          WHERE tenant_id = $1 ORDER BY size_system, sort_order, code`,
        [tenantId],
      ),
      await q.query(`SELECT id, name FROM catalog.size_charts WHERE tenant_id = $1 ORDER BY name`, [tenantId]),
    ];
    return { brands: brands.rows, categories: categories.rows, colors: colors.rows, sizes: sizes.rows, sizeCharts: sizeCharts.rows };
  }

  async insertBrand(q: Queryable, tenantId: string, name: string, slug: string) {
    try {
      const { rows } = await q.query(
        `INSERT INTO catalog.brands (tenant_id, name, slug) VALUES ($1, $2, $3) RETURNING id, name, slug, active`,
        [tenantId, name, slug],
      );
      return rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) throw new LookupTakenError('brand', name);
      throw error;
    }
  }

  async findCategory(q: Queryable, tenantId: string, id: string) {
    const { rows } = await q.query<{ id: string; path: string }>(`SELECT id, path FROM catalog.categories WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return rows[0] ?? null;
  }

  async insertCategory(q: Queryable, tenantId: string, c: { parentId: string | null; name: string; slug: string; path: string }) {
    try {
      const { rows } = await q.query(
        `INSERT INTO catalog.categories (tenant_id, parent_id, name, slug, path) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, parent_id AS "parentId", name, slug, path, active`,
        [tenantId, c.parentId, c.name, c.slug, c.path],
      );
      return rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) throw new LookupTakenError('category', c.path);
      throw error;
    }
  }

  async insertColor(q: Queryable, tenantId: string, name: string, hex: string | null) {
    try {
      const { rows } = await q.query(`INSERT INTO catalog.colors (tenant_id, name, hex) VALUES ($1, $2, $3) RETURNING id, name, hex`, [tenantId, name, hex]);
      return rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) throw new LookupTakenError('color', name);
      throw error;
    }
  }

  async insertSize(q: Queryable, tenantId: string, s: { code: string; sizeSystem: SizeSystem; sortOrder: number }) {
    try {
      const { rows } = await q.query(
        `INSERT INTO catalog.sizes (tenant_id, code, size_system, sort_order) VALUES ($1, $2, $3, $4)
         RETURNING id, code, size_system AS "sizeSystem", sort_order AS "sortOrder"`,
        [tenantId, s.code, s.sizeSystem, s.sortOrder],
      );
      return rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) throw new LookupTakenError('size', `${s.sizeSystem}/${s.code}`);
      throw error;
    }
  }

  async lookupVariants(
    q: Queryable,
    tenantId: string,
    by: { barcode: string } | { ids: string[] } | { text: string; limit: number },
  ): Promise<VariantLookupItem[]> {
    const select = `
      SELECT v.id, p.id AS product_id, v.sku, v.barcode, p.name AS product_name, co.name AS color, s.code AS size,
             COALESCE(v.price, p.base_price) AS price, v.status, p.status AS product_status
        FROM catalog.product_variants v
        JOIN catalog.products p ON p.id = v.product_id
        LEFT JOIN catalog.colors co ON co.id = v.color_id
        LEFT JOIN catalog.sizes s ON s.id = v.size_id
       WHERE p.tenant_id = $1 AND p.deleted_at IS NULL`;
    type Row = {
      id: string;
      product_id: string;
      sku: string;
      barcode: string | null;
      product_name: string;
      color: string | null;
      size: string | null;
      price: string;
      status: VariantLookupItem['status'];
      product_status: VariantLookupItem['productStatus'];
    };
    const { rows } =
      'barcode' in by
        ? await q.query<Row>(`${select} AND v.barcode = $2`, [tenantId, by.barcode])
        : 'ids' in by
          ? // Los ids de otro tenant simplemente no aparecen: el filtro por tenant está en el WHERE base.
            await q.query<Row>(`${select} AND v.id = ANY($2::uuid[]) ORDER BY p.name, v.sku`, [tenantId, by.ids])
          : await q.query<Row>(
              // Coincidencias exactas de SKU o código de barras primero; luego por prefijo y por nombre.
              `${select} AND (v.sku ILIKE $2 OR v.barcode ILIKE $2 OR p.name ILIKE $2)
                ORDER BY (lower(v.sku) = lower($3) OR v.barcode = $3) DESC, (v.sku ILIKE $4) DESC, p.name, v.sku
                LIMIT $5`,
              [tenantId, `%${likeEscape(by.text)}%`, by.text, `${likeEscape(by.text)}%`, by.limit],
            );
    return rows.map((r) => ({
      variantId: r.id,
      productId: r.product_id,
      sku: r.sku,
      barcode: r.barcode,
      productName: r.product_name,
      color: r.color,
      size: r.size,
      price: r.price,
      status: r.status,
      productStatus: r.product_status,
    }));
  }

  async insertMedia(
    q: Queryable,
    m: { productId: string; colorId: string | null; storageKey: string; altText: string | null; width: number | null; height: number | null },
  ) {
    const { rows } = await q.query<{ id: string; sort_order: number }>(
      `INSERT INTO catalog.product_media (product_id, color_id, media_type, storage_key, alt_text, width, height, sort_order)
       VALUES ($1, $2, 'image', $3, $4, $5, $6,
               (SELECT COALESCE(max(sort_order) + 1, 0) FROM catalog.product_media WHERE product_id = $1))
       RETURNING id, sort_order`,
      [m.productId, m.colorId, m.storageKey, m.altText, m.width, m.height],
    );
    return { id: rows[0].id, sortOrder: rows[0].sort_order };
  }

  async findMedia(q: Queryable, tenantId: string, id: string): Promise<MediaRecord | null> {
    const { rows } = await q.query<{ id: string; product_id: string; storage_key: string }>(
      `SELECT m.id, m.product_id, m.storage_key FROM catalog.product_media m
         JOIN catalog.products p ON p.id = m.product_id
        WHERE p.tenant_id = $1 AND m.id = $2`,
      [tenantId, id],
    );
    return rows[0] ? { id: rows[0].id, productId: rows[0].product_id, storageKey: rows[0].storage_key } : null;
  }

  async deleteMedia(q: Queryable, id: string): Promise<void> {
    await q.query(`DELETE FROM catalog.product_media WHERE id = $1`, [id]);
  }

  async updateMedia(q: Queryable, id: string, patch: { colorId?: string | null; altText?: string | null; sortOrder?: number }) {
    const set = buildSetClause(patch, { colorId: 'color_id', altText: 'alt_text', sortOrder: 'sort_order' }, 2);
    const { rows } = await q.query<{ id: string; storage_key: string; color_id: string | null; sort_order: number; alt_text: string | null }>(
      set.sql
        ? `UPDATE catalog.product_media SET ${set.sql} WHERE id = $1 RETURNING id, storage_key, color_id, sort_order, alt_text`
        : `SELECT id, storage_key, color_id, sort_order, alt_text FROM catalog.product_media WHERE id = $1`,
      [id, ...set.values],
    );
    const r = rows[0];
    return { id: r.id, storageKey: r.storage_key, colorId: r.color_id, sortOrder: r.sort_order, altText: r.alt_text };
  }
}
