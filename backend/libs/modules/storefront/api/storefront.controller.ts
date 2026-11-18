import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { Public, TenantId } from '../../../shared-kernel';
import { StorefrontService } from '../application/storefront.service';
import { ListProductsQuery, ProductSlugParam, ProductThumbsQuery, SuggestQuery } from './dto/storefront.dto';

/**
 * Catálogo público. Anónimo: el tenant llega en X-Tenant-Id (lo fija Caddy, o el servidor del
 * storefront en el SSR). Solo datos públicos, así que la respuesta se puede cachear un minuto
 * (el storefront además regenera sus páginas con ISR).
 */
const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';

@Controller('catalog')
@Public()
export class StorefrontController {
  constructor(private readonly storefront: StorefrontService) {}

  @Get('products')
  @Header('Cache-Control', PUBLIC_CACHE)
  list(@TenantId() tenantId: string, @Query() q: ListProductsQuery) {
    return this.storefront.list(tenantId, {
      filter: {
        category: q.category,
        collection: q.collection,
        genders: q.gender,
        brands: q.brand,
        colors: q.color,
        sizes: q.size,
        minPrice: q.minPrice,
        maxPrice: q.maxPrice,
        onSale: q.onSale === 'true',
        q: q.q,
      },
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('products/:slug')
  @Header('Cache-Control', PUBLIC_CACHE)
  product(@TenantId() tenantId: string, @Param() p: ProductSlugParam) {
    return this.storefront.product(tenantId, p.slug);
  }

  @Get('product-thumbs')
  @Header('Cache-Control', PUBLIC_CACHE)
  thumbs(@TenantId() tenantId: string, @Query() q: ProductThumbsQuery) {
    return this.storefront.thumbs(tenantId, q.ids);
  }

  @Get('search/suggest')
  @Header('Cache-Control', PUBLIC_CACHE)
  suggest(@TenantId() tenantId: string, @Query() q: SuggestQuery) {
    return this.storefront.suggest(tenantId, q.q);
  }

  @Get('categories')
  @Header('Cache-Control', PUBLIC_CACHE)
  categories(@TenantId() tenantId: string) {
    return this.storefront.categories(tenantId);
  }

  @Get('brands')
  @Header('Cache-Control', PUBLIC_CACHE)
  brands(@TenantId() tenantId: string) {
    return this.storefront.brands(tenantId);
  }

  @Get('collections')
  @Header('Cache-Control', PUBLIC_CACHE)
  collections(@TenantId() tenantId: string) {
    return this.storefront.collections(tenantId);
  }

  @Get('sitemap')
  @Header('Cache-Control', PUBLIC_CACHE)
  sitemap(@TenantId() tenantId: string) {
    return this.storefront.sitemap(tenantId);
  }
}
