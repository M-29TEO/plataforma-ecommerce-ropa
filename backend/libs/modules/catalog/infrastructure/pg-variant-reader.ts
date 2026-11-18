import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { VariantLabelRow, VariantReader } from '../application/ports';
import { SellableVariant } from '../domain/sellable-variant';

interface Row {
  variant_id: string;
  product_id: string;
  sku: string;
  product_name: string;
  brand_id: string | null;
  brand_name: string | null;
  category_id: string;
  category_path: string;
  color_name: string | null;
  size_code: string | null;
  price: string;
  compare_at_price: string | null;
  tax_code: string;
  unit_cost: string | null;
  weight_g: number;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
  purchasable: boolean;
}

@Injectable()
export class PgVariantReader extends VariantReader {
  async findSellable(q: Queryable, tenantId: string, variantIds: string[]): Promise<SellableVariant[]> {
    const { rows } = await q.query<Row>(
      `SELECT v.id AS variant_id, p.id AS product_id, v.sku, p.name AS product_name,
              b.id AS brand_id, b.name AS brand_name, c.id AS category_id, c.path AS category_path,
              co.name AS color_name, s.code AS size_code,
              COALESCE(v.price, p.base_price) AS price,
              COALESCE(v.compare_at_price, p.compare_at_price) AS compare_at_price,
              p.tax_code, p.cost AS unit_cost, v.weight_g, v.length_mm, v.width_mm, v.height_mm,
              (p.status = 'active' AND p.deleted_at IS NULL AND v.status = 'active') AS purchasable
         FROM catalog.product_variants v
         JOIN catalog.products p ON p.id = v.product_id
         JOIN catalog.categories c ON c.id = p.category_id
         LEFT JOIN catalog.brands b ON b.id = p.brand_id
         LEFT JOIN catalog.colors co ON co.id = v.color_id
         LEFT JOIN catalog.sizes s ON s.id = v.size_id
        WHERE p.tenant_id = $1 AND v.id = ANY($2::uuid[])`,
      [tenantId, variantIds],
    );
    return rows.map((r) => ({
      variantId: r.variant_id,
      productId: r.product_id,
      sku: r.sku,
      productName: r.product_name,
      brandId: r.brand_id,
      brandName: r.brand_name,
      categoryId: r.category_id,
      categoryPath: r.category_path,
      colorName: r.color_name,
      sizeCode: r.size_code,
      price: r.price,
      compareAtPrice: r.compare_at_price,
      taxCode: r.tax_code,
      unitCost: r.unit_cost,
      weightG: r.weight_g,
      lengthMm: r.length_mm,
      widthMm: r.width_mm,
      heightMm: r.height_mm,
      purchasable: r.purchasable,
    }));
  }

  async findLabels(q: Queryable, tenantId: string, variantIds: string[]): Promise<VariantLabelRow[]> {
    const { rows } = await q.query<{ variant_id: string; sku: string; barcode: string | null; image_key: string | null }>(
      `SELECT v.id AS variant_id, v.sku, v.barcode,
              (SELECT m.storage_key FROM catalog.product_media m
                WHERE m.product_id = p.id AND m.media_type = 'image' AND (m.color_id = v.color_id OR m.color_id IS NULL)
                ORDER BY (m.color_id IS NULL), m.sort_order, m.id LIMIT 1) AS image_key
         FROM catalog.product_variants v
         JOIN catalog.products p ON p.id = v.product_id
        WHERE p.tenant_id = $1 AND v.id = ANY($2::uuid[])`,
      [tenantId, variantIds],
    );
    return rows.map((r) => ({ variantId: r.variant_id, sku: r.sku, barcode: r.barcode, imageKey: r.image_key }));
  }
}
