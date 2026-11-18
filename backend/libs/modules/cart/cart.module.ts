import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { InventoryModule } from '../inventory';
import { PromotionsModule } from '../promotions';
import { CartController } from './api/cart.controller';
import { AbandonedCartService } from './application/abandoned-cart.service';
import { CartApi } from './application/cart.api';
import { CartService } from './application/cart.service';
import { CartRepository } from './application/ports';
import { AbandonedCartJob } from './infrastructure/jobs/abandoned-cart.job';
import { PgCartRepository } from './infrastructure/pg-cart.repository';
import { CartPersonalDataContributor } from './infrastructure/personal-data.contributor';

/**
 * Módulo Carrito (schema sales: carts, cart_items). Lee precios e IVA de Catálogo, stock de
 * Inventario y descuentos de Promociones, siempre por sus fachadas públicas. Su cron emite
 * CartAbandoned (1 h, 24 h, 72 h) para los recordatorios que envía Notificaciones.
 */
@Module({
  imports: [CatalogModule, InventoryModule, PromotionsModule],
  controllers: [CartController],
  providers: [
    { provide: CartRepository, useClass: PgCartRepository },
    CartService,
    CartApi,
    AbandonedCartService,
    CartPersonalDataContributor,
  ],
  exports: [CartApi, AbandonedCartService],
})
export class CartModule {}

/** Jobs del proceso worker (recordatorios de carrito abandonado). Requiere QueueModule. */
@Module({ imports: [CartModule], providers: [AbandonedCartJob] })
export class CartWorkerModule {}
