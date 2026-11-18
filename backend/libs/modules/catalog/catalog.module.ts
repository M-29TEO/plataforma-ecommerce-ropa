import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, createObjectStorage } from '../../shared-kernel';
import { CatalogAdminController, CatalogVariantLookupController } from './api/catalog-admin.controller';
import { CatalogAdminRepository, ProductMediaStorage } from './application/admin-ports';
import { CatalogAdminService } from './application/catalog-admin.service';
import { CatalogApi } from './application/catalog.api';
import { CatalogStorefrontApi } from './application/catalog-storefront.api';
import { ProductOfferReader, VariantReader } from './application/ports';
import { StorefrontReader } from './application/storefront-ports';
import { PgCatalogAdminRepository } from './infrastructure/pg-catalog-admin.repository';
import { PgProductOfferReader } from './infrastructure/pg-product-offer-reader';
import { PgStorefrontReader } from './infrastructure/pg-storefront-reader';
import { PgVariantReader } from './infrastructure/pg-variant-reader';

/**
 * Módulo Catálogo (schema catalog). La fachada de lectura que usan Carrito, Checkout y CRM, y la
 * del catálogo público (CatalogStorefrontApi) que usa el orquestador Storefront. No importa ningún
 * otro módulo (las reseñas y preguntas van en CatalogReviewsModule). También expone la
 * administración del catálogo del backoffice (/catalog/admin/...) y la búsqueda de variantes por
 * código de barras (/catalog/variants/lookup); no debe importar Inventario (ciclo de imports).
 */
@Module({
  controllers: [CatalogAdminController, CatalogVariantLookupController],
  providers: [
    { provide: CatalogAdminRepository, useClass: PgCatalogAdminRepository },
    {
      provide: ProductMediaStorage,
      inject: [APP_CONFIG],
      // Mismo almacén (y driver) que las fotos de reseñas; las claves van con prefijo products/.
      useFactory: (c: AppConfig) => createObjectStorage(c.catalog.reviewPhotoStorage, c.catalog.seaweedFilerUrl),
    },
    CatalogAdminService,
    { provide: VariantReader, useClass: PgVariantReader },
    { provide: ProductOfferReader, useClass: PgProductOfferReader },
    { provide: StorefrontReader, useClass: PgStorefrontReader },
    CatalogApi,
    CatalogStorefrontApi,
  ],
  exports: [CatalogApi, CatalogStorefrontApi],
})
export class CatalogModule {}
