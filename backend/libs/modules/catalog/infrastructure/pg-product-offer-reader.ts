import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { ProductOfferReader } from '../application/ports';
import { ProductOffer } from '../domain/product-offer';

interface Row {
  product_id: string;
  name: string;
  slug: string;
  tax_code: string;
  purchasable: boolean;
  variants: Array<{ variantId: string; price: string; purchasable: boolean }> | null;
}

@Injectable()
export class PgProductOfferReader extends ProductOfferReader {
  async findOffers(q: Queryable, tenantId: string, productIds: string[]): Promise<ProductOffer[]> {
    const { rows } = await q.query<Row>(
      `SELECT p.id AS product_id, p.name, p.slug, p.tax_code, (p.status = 'active') AS purchasable,
              (SELECT json_agg(json_build_object(
                        'variantId', v.id,
                        'price', to_char(COALESCE(v.price, p.base_price), 'FM9999999990.00'),
                        'purchasable', v.status = 'active') ORDER BY v.id)
                 FROM catalog.product_variants v WHERE v.product_id = p.id) AS variants
         FROM catalog.products p
        WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[]) AND p.deleted_at IS NULL`,
      [tenantId, productIds],
    );
    return rows.map((r) => ({
      productId: r.product_id,
      name: r.name,
      slug: r.slug,
      taxCode: r.tax_code,
      purchasable: r.purchasable,
      variants: r.variants ?? [],
    }));
  }
}
