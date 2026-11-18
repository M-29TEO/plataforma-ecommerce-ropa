/**
 * API PÚBLICA del módulo Catálogo. Otros módulos solo pueden importar desde aquí.
 */
export { CatalogModule } from './catalog.module';
export { CatalogReviewsModule } from './reviews.module';
export { CatalogApi } from './application/catalog.api';
export { CatalogStorefrontApi } from './application/catalog-storefront.api';
export type { VariantLabel } from './application/catalog.api';
export type { BrandView, CategoryNode, CollectionView, ProductDetailRow, ProductThumb, SitemapEntry, Suggestions } from './application/storefront-ports';
export {
  GENDERS,
  MAX_PAGE_SIZE,
  normalizeSearch,
  parseList,
  ProductSlugNotFoundError,
  STOREFRONT_SORTS,
  stockLevel,
} from './domain/storefront';
export type { Gender, ListingPage, ListingQuery, ProductCard, ProductDetail, StorefrontSort } from './domain/storefront';
export type { ProductOffer } from './domain/product-offer';
export type { SellableVariant } from './domain/sellable-variant';
export { QUESTION_ANSWERED, REVIEW_APPROVED, REVIEW_REJECTED, REVIEW_SUBMITTED } from './domain/review-events';
export type { QuestionAnsweredPayload, ReviewEventPayload } from './domain/review-events';
