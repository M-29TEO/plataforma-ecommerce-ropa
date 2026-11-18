import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { InventoryModule } from '../inventory';
import { StorefrontController } from './api/storefront.controller';
import { StorefrontService } from './application/storefront.service';

/**
 * Módulo Storefront: orquestador sin schema propio (como Checkout) para el catálogo público. Junta
 * la lectura del Catálogo con la disponibilidad de Inventario por sus fachadas públicas; nadie lo
 * importa, así que no arma ciclos (Inventario ya importa CatalogModule).
 */
@Module({
  imports: [CatalogModule, InventoryModule],
  controllers: [StorefrontController],
  providers: [StorefrontService],
})
export class StorefrontModule {}
