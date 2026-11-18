import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { Queryable } from '../../../shared-kernel';
import {
  BrandView,
  CategoryNode,
  CollectionView,
  ProductDetailRow,
  ProductThumb,
  SitemapEntry,
  StorefrontReader,
  Suggestions,
} from '../application/storefront-ports';
import {
  categoryAncestors,
  ColorView,
  effectiveSort,
  escapeLike,
  Facets,
  Gender,
  GENDER_LABELS,
  ListingFilter,
  ListingQuery,
  mediaUrl,
  MediaView,
  ProductCard,
  StorefrontSort,
} from '../domain/storefront';

/** Filtros con faceta propia: al contar una faceta se ignora su propio filtro (facetas disyuntivas). */
type FacetKey = 'brand' | 'color' | 'size' | 'gender' | 'price';

/** Similitud mínima (pg_trgm.word_similarity) para aceptar un nombre con errores de tipeo. */
const FUZZY_THRESHOLD = 0.5;

const FROM = `catalog.products p
  JOIN catalog.categories c ON c.id = p.category_id
  LEFT JOIN catalog.brands b ON b.id = p.brand_id`;

/** Las variantes se filtran con los alias v (variante), co (color) y s (talla). */
const VARIANT_JOINS = `LEFT JOIN catalog.colors co ON co.id = v.color_id
  LEFT JOIN catalog.sizes s ON s.id = v.size_id`;

const PRICE = 'COALESCE(v.price, p.base_price)';
const COMPARE_AT = 'COALESCE(v.compare_at_price, p.compare_at_price)';
const MONEY = (expr: string) => `to_char(${expr}, 'FM9999999990.00')`;

class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

interface Conditions {
  product: string;
  variant: string;
  /** Expresión de relevancia (0 sin texto de búsqueda). */
  rank: string;
}

/** Producto publicado del tenant: lo único que ve la tienda. */
function published(p: Params, tenantId: string): string[] {
  return [
    `p.tenant_id = ${p.add(tenantId)}`,
    `p.status = 'active'`,
    `p.deleted_at IS NULL`,
    `(p.published_at IS NULL OR p.published_at <= now())`,
    `c.active`,
  ];
}

function conditions(p: Params, tenantId: string, f: ListingFilter, exclude?: FacetKey): Conditions {
  const product = published(p, tenantId);
  const variant = [`v.status = 'active'`];
  let rank = '0';

  if (f.category) {
    const path = p.add(f.category);
    product.push(`(c.path = ${path} OR left(c.path, length(${path}) + 1) = ${path} || '/')`);
  }
  if (f.collection) {
    product.push(`EXISTS (SELECT 1 FROM catalog.product_collections pc
                            JOIN catalog.collections col ON col.id = pc.collection_id
                           WHERE pc.product_id = p.id AND col.tenant_id = p.tenant_id AND col.slug = ${p.add(f.collection)})`);
  }
  if (f.genders.length > 0 && exclude !== 'gender') product.push(`p.gender = ANY(${p.add(f.genders)}::text[])`);
  if (f.brands.length > 0 && exclude !== 'brand') product.push(`b.slug = ANY(${p.add(f.brands)}::text[])`);
  if (f.q) {
    const q = p.add(f.q);
    const like = p.add(`%${escapeLike(f.q)}%`);
    product.push(`(p.search_vector @@ websearch_to_tsquery('spanish', ${q})
                   OR p.name ILIKE ${like} OR b.name ILIKE ${like}
                   OR word_similarity(${q}, p.name) >= ${FUZZY_THRESHOLD})`);
    rank = `(ts_rank(p.search_vector, websearch_to_tsquery('spanish', ${q})) + word_similarity(${q}, p.name))`;
  }

  if (f.colors.length > 0 && exclude !== 'color') variant.push(`lower(co.name) = ANY(${p.add(f.colors.map((c) => c.toLowerCase()))}::text[])`);
  if (f.sizes.length > 0 && exclude !== 'size') variant.push(`s.code = ANY(${p.add(f.sizes)}::text[])`);
  if (exclude !== 'price') {
    if (f.minPrice) variant.push(`${PRICE} >= ${p.add(f.minPrice)}::numeric`);
    if (f.maxPrice) variant.push(`${PRICE} <= ${p.add(f.maxPrice)}::numeric`);
  }
  if (f.onSale) variant.push(`${COMPARE_AT} > ${PRICE}`);

  return { product: product.join(' AND '), variant: variant.join(' AND '), rank };
}

function hasVariant(c: Conditions): string {
  return `EXISTS (SELECT 1 FROM catalog.product_variants v ${VARIANT_JOINS} WHERE v.product_id = p.id AND ${c.variant})`;
}

/** Mismo orden dentro de la página (subconsulta) y fuera: las columnas tienen el mismo nombre. */
const ORDER_BY: Record<StorefrontSort, string> = {
  relevance: 'rank DESC, sort_date DESC, id',
  newest: 'sort_date DESC, id',
  price_asc: 'price_num ASC, id',
  price_desc: 'price_num DESC, id',
  rating: 'rating_num DESC, rating_count DESC, id',
};

interface MediaJson {
  storageKey: string;
  alt: string | null;
  colorName: string | null;
  width: number | null;
  height: number | null;
}

interface CardRow {
  id: string;
  slug: string;
  name: string;
  brand_name: string | null;
  brand_slug: string | null;
  price: string;
  compare_at_price: string | null;
  rating_avg: string;
  rating_count: number;
  images: MediaJson[] | null;
  colors: ColorView[] | null;
  variant_ids: string[];
}

function toMedia(baseUrl: string, m: MediaJson): MediaView {
  return { url: mediaUrl(baseUrl, m.storageKey), alt: m.alt, colorName: m.colorName, width: m.width, height: m.height };
}

/** Precio tachado solo si de verdad es mayor que el precio de venta. */
function compareAt(price: string, compare: string | null): string | null {
  return compare !== null && Number(compare) > Number(price) ? compare : null;
}

@Injectable()
export class PgStorefrontReader extends StorefrontReader {
  async list(q: Queryable, tenantId: string, query: ListingQuery, mediaBaseUrl: string): Promise<{ items: ProductCard[]; total: number }> {
    const f = query.filter;
    const p = new Params();
    const c = conditions(p, tenantId, f);
    const sort = effectiveSort(query.sort, f.q);
    // Con filtro de color, primero las fotos de ese color.
    const colorFirst = f.colors.length > 0 ? `(lower(mc.name) = ANY(${p.add(f.colors.map((x) => x.toLowerCase()))}::text[])) DESC NULLS LAST, ` : '';
    const limit = p.add(query.pageSize);
    const offset = p.add((query.page - 1) * query.pageSize);

    // "best": la variante más barata que cumple los filtros (precio que se muestra en la tarjeta).
    const { rows } = await q.query<CardRow>(
      `SELECT page.*,
              (SELECT json_agg(img ORDER BY ord) FROM (
                 SELECT json_build_object('storageKey', m.storage_key, 'alt', m.alt_text, 'colorName', mc.name,
                                          'width', m.width, 'height', m.height) AS img,
                        row_number() OVER (ORDER BY ${colorFirst}m.sort_order, m.id) AS ord
                   FROM catalog.product_media m LEFT JOIN catalog.colors mc ON mc.id = m.color_id
                  WHERE m.product_id = page.id AND m.media_type = 'image'
                  ORDER BY ord LIMIT 2) first_two) AS images,
              (SELECT json_agg(DISTINCT jsonb_build_object('name', co.name, 'hex', co.hex))
                 FROM catalog.product_variants v JOIN catalog.colors co ON co.id = v.color_id
                WHERE v.product_id = page.id AND v.status = 'active') AS colors,
              (SELECT array_agg(v.id) FROM catalog.product_variants v
                WHERE v.product_id = page.id AND v.status = 'active') AS variant_ids
         FROM (
           SELECT p.id, p.slug, p.name, b.name AS brand_name, b.slug AS brand_slug,
                  ${MONEY('best.price')} AS price, ${MONEY('best.compare_at')} AS compare_at_price,
                  best.price AS price_num, p.rating_avg AS rating_num,
                  to_char(p.rating_avg, 'FM0.00') AS rating_avg, p.rating_count,
                  COALESCE(p.published_at, p.created_at) AS sort_date, ${c.rank} AS rank
             FROM ${FROM}
             CROSS JOIN LATERAL (
               SELECT ${PRICE} AS price, ${COMPARE_AT} AS compare_at
                 FROM catalog.product_variants v ${VARIANT_JOINS}
                WHERE v.product_id = p.id AND ${c.variant}
                ORDER BY 1 LIMIT 1) best
            WHERE ${c.product}
            ORDER BY ${ORDER_BY[sort]}
            LIMIT ${limit} OFFSET ${offset}
         ) page
        ORDER BY ${ORDER_BY[sort]}`,
      p.values,
    );

    const countParams = new Params();
    const cc = conditions(countParams, tenantId, f);
    const { rows: count } = await q.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM ${FROM} WHERE ${cc.product} AND ${hasVariant(cc)}`,
      countParams.values,
    );

    const items = rows.map(
      (r): ProductCard => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        brand: r.brand_slug ? { name: r.brand_name!, slug: r.brand_slug } : null,
        price: r.price,
        compareAtPrice: compareAt(r.price, r.compare_at_price),
        images: (r.images ?? []).map((m) => toMedia(mediaBaseUrl, m)),
        colors: (r.colors ?? []).sort((a, b) => a.name.localeCompare(b.name, 'es')),
        ratingAvg: r.rating_avg,
        ratingCount: r.rating_count,
        available: false,
        variantIds: r.variant_ids ?? [],
      }),
    );
    return { items, total: count[0].total };
  }

  async facets(q: Queryable, tenantId: string, query: ListingQuery): Promise<Facets> {
    const f = query.filter;
    const run = <T extends QueryResultRow>(exclude: FacetKey, sql: (c: Conditions) => string) => {
      const p = new Params();
      const c = conditions(p, tenantId, f, exclude);
      return q.query<T>(sql(c), p.values).then((r) => r.rows);
    };

    const [brands, colors, sizes, genders, price] = await Promise.all([
      run<{ value: string; label: string; count: number }>(
        'brand',
        (c) => `SELECT b.slug AS value, b.name AS label, count(*)::int AS count
                  FROM ${FROM} WHERE ${c.product} AND b.id IS NOT NULL AND ${hasVariant(c)}
                 GROUP BY b.slug, b.name ORDER BY b.name`,
      ),
      run<{ value: string; label: string; hex: string | null; count: number }>(
        'color',
        (c) => `SELECT co.name AS value, co.name AS label, co.hex, count(DISTINCT p.id)::int AS count
                  FROM ${FROM}
                  JOIN catalog.product_variants v ON v.product_id = p.id
                  JOIN catalog.colors co ON co.id = v.color_id
                  LEFT JOIN catalog.sizes s ON s.id = v.size_id
                 WHERE ${c.product} AND ${c.variant}
                 GROUP BY co.name, co.hex ORDER BY co.name`,
      ),
      run<{ value: string; label: string; count: number }>(
        'size',
        (c) => `SELECT s.code AS value, s.code AS label, count(DISTINCT p.id)::int AS count
                  FROM ${FROM}
                  JOIN catalog.product_variants v ON v.product_id = p.id
                  JOIN catalog.sizes s ON s.id = v.size_id
                  LEFT JOIN catalog.colors co ON co.id = v.color_id
                 WHERE ${c.product} AND ${c.variant}
                 GROUP BY s.code, s.size_system, s.sort_order ORDER BY s.size_system, s.sort_order, s.code`,
      ),
      run<{ value: Gender; count: number }>(
        'gender',
        (c) => `SELECT p.gender AS value, count(*)::int AS count
                  FROM ${FROM} WHERE ${c.product} AND ${hasVariant(c)}
                 GROUP BY p.gender ORDER BY p.gender`,
      ),
      run<{ min: string | null; max: string | null }>(
        'price',
        (c) => `SELECT ${MONEY(`min(${PRICE})`)} AS min, ${MONEY(`max(${PRICE})`)} AS max
                  FROM ${FROM}
                  JOIN catalog.product_variants v ON v.product_id = p.id
                  ${VARIANT_JOINS}
                 WHERE ${c.product} AND ${c.variant}`,
      ),
    ]);

    // Las tallas pueden repetir código entre sistemas (alpha 'S' vs. otro): se suman.
    const sizeMap = new Map<string, number>();
    for (const s of sizes) sizeMap.set(s.value, (sizeMap.get(s.value) ?? 0) + s.count);

    return {
      brands,
      colors,
      sizes: [...sizeMap].map(([value, count]) => ({ value, label: value, count })),
      genders: genders.map((g) => ({ value: g.value, label: GENDER_LABELS[g.value] ?? g.value, count: g.count })),
      price: { min: price[0]?.min ?? null, max: price[0]?.max ?? null },
    };
  }

  async findBySlug(q: Queryable, tenantId: string, slug: string, mediaBaseUrl: string): Promise<ProductDetailRow | null> {
    const p = new Params();
    const where = [...published(p, tenantId), `p.slug = ${p.add(slug)}`].join(' AND ');
    const { rows } = await q.query<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      gender: Gender;
      material: string | null;
      care_instructions: string | null;
      attributes: Record<string, unknown>;
      seo: Record<string, unknown>;
      brand_name: string | null;
      brand_slug: string | null;
      category_name: string;
      category_slug: string;
      category_path: string;
      base_price: string;
      compare_at_price: string | null;
      rating_avg: string;
      rating_count: number;
      chart_name: string | null;
      chart_data: Record<string, unknown> | null;
      updated_at: Date;
    }>(
      `SELECT p.id, p.slug, p.name, p.description, p.gender, p.material, p.care_instructions, p.attributes, p.seo,
              b.name AS brand_name, b.slug AS brand_slug,
              c.name AS category_name, c.slug AS category_slug, c.path AS category_path,
              ${MONEY('p.base_price')} AS base_price, ${MONEY('p.compare_at_price')} AS compare_at_price,
              to_char(p.rating_avg, 'FM0.00') AS rating_avg, p.rating_count,
              sc.name AS chart_name, sc.data AS chart_data, p.updated_at
         FROM ${FROM}
         LEFT JOIN catalog.size_charts sc ON sc.id = p.size_chart_id AND sc.tenant_id = p.tenant_id
        WHERE ${where}`,
      p.values,
    );
    const r = rows[0];
    if (!r) return null;

    const [breadcrumb, media, variants] = await Promise.all([
      q.query<{ name: string; slug: string; path: string }>(
        `SELECT name, slug, path FROM catalog.categories
          WHERE tenant_id = $1 AND path = ANY($2::text[]) ORDER BY length(path)`,
        [tenantId, categoryAncestors(r.category_path)],
      ),
      q.query<{ storage_key: string; alt_text: string | null; color_name: string | null; width: number | null; height: number | null }>(
        `SELECT m.storage_key, m.alt_text, mc.name AS color_name, m.width, m.height
           FROM catalog.product_media m LEFT JOIN catalog.colors mc ON mc.id = m.color_id
          WHERE m.product_id = $1 AND m.media_type = 'image'
          ORDER BY m.sort_order, m.id`,
        [r.id],
      ),
      q.query<{
        id: string;
        sku: string;
        color_name: string | null;
        color_hex: string | null;
        size_code: string | null;
        size_rank: string | null;
        price: string;
        compare_at_price: string | null;
      }>(
        `SELECT v.id, v.sku, co.name AS color_name, co.hex AS color_hex, s.code AS size_code,
                s.size_system || lpad(s.sort_order::text, 6, '0') AS size_rank,
                ${MONEY(PRICE)} AS price, ${MONEY(COMPARE_AT)} AS compare_at_price
           FROM catalog.product_variants v
           JOIN catalog.products p ON p.id = v.product_id
           ${VARIANT_JOINS}
          WHERE v.product_id = $1 AND v.status = 'active'
          ORDER BY co.name NULLS FIRST, s.size_system, s.sort_order, v.sku`,
        [r.id],
      ),
    ]);

    const colors = new Map<string, ColorView>();
    // Las filas vienen ordenadas por color y luego por talla: las tallas se ordenan por la talla en sí.
    const sizeRanks = new Map<string, string>();
    for (const v of variants.rows) {
      if (v.color_name && !colors.has(v.color_name)) colors.set(v.color_name, { name: v.color_name, hex: v.color_hex });
      if (v.size_code && !sizeRanks.has(v.size_code)) sizeRanks.set(v.size_code, v.size_rank ?? '');
    }
    const sizes = [...sizeRanks].sort((a, b) => a[1].localeCompare(b[1])).map(([code]) => code);

    const minVariant = variants.rows.reduce<(typeof variants.rows)[number] | null>(
      (min, v) => (min === null || Number(v.price) < Number(min.price) ? v : min),
      null,
    );
    const price = minVariant?.price ?? r.base_price;
    const seo = r.seo ?? {};

    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      gender: r.gender,
      material: r.material,
      careInstructions: r.care_instructions,
      attributes: r.attributes ?? {},
      seo: {
        title: typeof seo.title === 'string' ? seo.title : undefined,
        description: typeof seo.description === 'string' ? seo.description : undefined,
      },
      brand: r.brand_slug ? { name: r.brand_name!, slug: r.brand_slug } : null,
      category: { name: r.category_name, slug: r.category_slug, path: r.category_path },
      breadcrumb: breadcrumb.rows,
      price,
      compareAtPrice: compareAt(price, minVariant?.compare_at_price ?? r.compare_at_price),
      ratingAvg: r.rating_avg,
      ratingCount: r.rating_count,
      media: media.rows.map((m) =>
        toMedia(mediaBaseUrl, { storageKey: m.storage_key, alt: m.alt_text, colorName: m.color_name, width: m.width, height: m.height }),
      ),
      colors: [...colors.values()],
      sizes,
      variants: variants.rows.map((v) => ({
        id: v.id,
        sku: v.sku,
        color: v.color_name ? { name: v.color_name, hex: v.color_hex } : null,
        size: v.size_code,
        price: v.price,
        compareAtPrice: compareAt(v.price, v.compare_at_price),
      })),
      sizeChart: r.chart_data ? { name: r.chart_name ?? 'Guía de tallas', data: r.chart_data } : null,
      updatedAt: r.updated_at.toISOString(),
    };
  }

  async categories(q: Queryable, tenantId: string): Promise<CategoryNode[]> {
    const { rows } = await q.query<{
      id: string;
      name: string;
      slug: string;
      path: string;
      parent_path: string | null;
      sort_order: number;
      product_count: number;
    }>(
      `SELECT c.id, c.name, c.slug, c.path, parent.path AS parent_path, c.sort_order,
              (SELECT count(*)::int FROM catalog.products p JOIN catalog.categories pc ON pc.id = p.category_id
                WHERE p.tenant_id = c.tenant_id AND p.status = 'active' AND p.deleted_at IS NULL
                  AND (p.published_at IS NULL OR p.published_at <= now()) AND pc.active
                  AND (pc.path = c.path OR left(pc.path, length(c.path) + 1) = c.path || '/')
                  AND EXISTS (SELECT 1 FROM catalog.product_variants v WHERE v.product_id = p.id AND v.status = 'active')
              ) AS product_count
         FROM catalog.categories c
         LEFT JOIN catalog.categories parent ON parent.id = c.parent_id
        WHERE c.tenant_id = $1 AND c.active
        ORDER BY c.path, c.sort_order`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      path: r.path,
      // Sin parent_id, el padre se deduce de la ruta ('mujer/vestidos' → 'mujer').
      parentPath: r.parent_path ?? (r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : null),
      sortOrder: r.sort_order,
      productCount: r.product_count,
    }));
  }

  async brands(q: Queryable, tenantId: string): Promise<BrandView[]> {
    const { rows } = await q.query<{ name: string; slug: string; logo_url: string | null; product_count: number }>(
      `SELECT b.name, b.slug, b.logo_url,
              (SELECT count(*)::int FROM catalog.products p JOIN catalog.categories c ON c.id = p.category_id
                WHERE p.brand_id = b.id AND p.status = 'active' AND p.deleted_at IS NULL
                  AND (p.published_at IS NULL OR p.published_at <= now()) AND c.active) AS product_count
         FROM catalog.brands b
        WHERE b.tenant_id = $1 AND b.active
        ORDER BY b.name`,
      [tenantId],
    );
    return rows.map((r) => ({ name: r.name, slug: r.slug, logoUrl: r.logo_url, productCount: r.product_count }));
  }

  async collections(q: Queryable, tenantId: string, now: Date): Promise<CollectionView[]> {
    const { rows } = await q.query<{ name: string; slug: string; starts_at: Date | null; ends_at: Date | null }>(
      `SELECT name, slug, starts_at, ends_at FROM catalog.collections
        WHERE tenant_id = $1 AND (starts_at IS NULL OR starts_at <= $2) AND (ends_at IS NULL OR ends_at > $2)
        ORDER BY starts_at DESC NULLS LAST, name`,
      [tenantId, now],
    );
    return rows.map((r) => ({
      name: r.name,
      slug: r.slug,
      startsAt: r.starts_at?.toISOString() ?? null,
      endsAt: r.ends_at?.toISOString() ?? null,
    }));
  }

  async suggest(q: Queryable, tenantId: string, text: string, mediaBaseUrl: string): Promise<Suggestions> {
    const p = new Params();
    const c = conditions(p, tenantId, { genders: [], brands: [], colors: [], sizes: [], onSale: false, q: text });
    const like = `%${escapeLike(text)}%`;
    const [products, categories, brands] = await Promise.all([
      q.query<{ slug: string; name: string; price: string; storage_key: string | null }>(
        `SELECT p.slug, p.name, ${MONEY('best.price')} AS price,
                (SELECT m.storage_key FROM catalog.product_media m
                  WHERE m.product_id = p.id AND m.media_type = 'image' ORDER BY m.sort_order, m.id LIMIT 1) AS storage_key
           FROM ${FROM}
           CROSS JOIN LATERAL (
             SELECT ${PRICE} AS price FROM catalog.product_variants v ${VARIANT_JOINS}
              WHERE v.product_id = p.id AND ${c.variant} ORDER BY 1 LIMIT 1) best
          WHERE ${c.product}
          ORDER BY ${c.rank} DESC, p.name
          LIMIT 6`,
        p.values,
      ),
      q.query<{ name: string; slug: string; path: string }>(
        `SELECT name, slug, path FROM catalog.categories
          WHERE tenant_id = $1 AND active AND (name ILIKE $2 OR word_similarity($3, name) >= ${FUZZY_THRESHOLD})
          ORDER BY word_similarity($3, name) DESC, length(path) LIMIT 3`,
        [tenantId, like, text],
      ),
      q.query<{ name: string; slug: string }>(
        `SELECT name, slug FROM catalog.brands
          WHERE tenant_id = $1 AND active AND (name ILIKE $2 OR word_similarity($3, name) >= ${FUZZY_THRESHOLD})
          ORDER BY word_similarity($3, name) DESC, name LIMIT 3`,
        [tenantId, like, text],
      ),
    ]);
    return {
      products: products.rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        price: r.price,
        imageUrl: r.storage_key ? mediaUrl(mediaBaseUrl, r.storage_key) : null,
      })),
      categories: categories.rows,
      brands: brands.rows,
    };
  }

  async sitemap(q: Queryable, tenantId: string, limit: number): Promise<SitemapEntry[]> {
    const p = new Params();
    const where = published(p, tenantId).join(' AND ');
    const lim = p.add(limit);
    const { rows } = await q.query<{ type: SitemapEntry['type']; key: string; updated_at: Date | null }>(
      `(SELECT 'category' AS type, path AS key, NULL::timestamptz AS updated_at
          FROM catalog.categories WHERE tenant_id = $1 AND active ORDER BY path)
       UNION ALL
       (SELECT 'brand', slug, NULL FROM catalog.brands WHERE tenant_id = $1 AND active ORDER BY slug)
       UNION ALL
       (SELECT 'product', p.slug, p.updated_at FROM ${FROM}
         WHERE ${where} AND EXISTS (SELECT 1 FROM catalog.product_variants v WHERE v.product_id = p.id AND v.status = 'active')
         ORDER BY p.updated_at DESC LIMIT ${lim})`,
      p.values,
    );
    return rows.map((r) => ({ type: r.type, key: r.key, updatedAt: r.updated_at?.toISOString() ?? null }));
  }

  async thumbs(q: Queryable, tenantId: string, ids: string[], mediaBaseUrl: string): Promise<ProductThumb[]> {
    const p = new Params();
    const where = [...published(p, tenantId), `p.id = ANY(${p.add(ids)}::uuid[])`].join(' AND ');
    const { rows } = await q.query<{ id: string; slug: string; name: string; images: MediaJson[] | null }>(
      `SELECT p.id, p.slug, p.name,
              (SELECT json_agg(json_build_object('storageKey', m.storage_key, 'alt', m.alt_text, 'colorName', mc.name,
                                                 'width', m.width, 'height', m.height) ORDER BY m.sort_order, m.id)
                 FROM catalog.product_media m LEFT JOIN catalog.colors mc ON mc.id = m.color_id
                WHERE m.product_id = p.id AND m.media_type = 'image') AS images
         FROM ${FROM} WHERE ${where}`,
      p.values,
    );
    return rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name, images: (row.images ?? []).map((m) => toMedia(mediaBaseUrl, m)) }));
  }

}
