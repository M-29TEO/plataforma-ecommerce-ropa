import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { CatalogApi } from '../../catalog';
import { VariantNotFoundError } from '../domain/errors';

/**
 * Verifica que las variantes sean del catálogo del tenant antes de tocar stock u órdenes de compra.
 * inventory.stock_levels solo tiene la FK a catalog.product_variants (sin tenant_id): sin esto se
 * podía ajustar o comprar la variante de otra tienda, y una inexistente salía como el 422 de la FK.
 */
@Injectable()
export class CatalogVariants {
  // forwardRef: catalog/index.ts reexporta el StorefrontModule, que importa Inventario; cuando este
  // archivo se carga, CatalogApi todavía puede ser undefined (ciclo de archivos, no de módulos Nest).
  constructor(@Inject(forwardRef(() => CatalogApi)) private readonly catalog: CatalogApi) {}

  async assertOfTenant(tenantId: string, variantIds: string[]): Promise<void> {
    const found = await this.catalog.getSellableVariants(tenantId, variantIds);
    const missing = [...new Set(variantIds)].filter((id) => !found.has(id));
    if (missing.length > 0) throw new VariantNotFoundError(missing);
  }
}
