import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { LogisticsModule } from '../logistics';
import { OrdersModule } from '../orders';
import { PickingController } from './api/picking.controller';
import { PickingService } from './application/picking.service';

/**
 * Módulo Fulfillment: orquestador sin schema propio (como Checkout, Posventa y Storefront) del
 * picking de bodega. Compone Pedidos, Catálogo y Logística por sus fachadas públicas. Logística ya
 * importa Pedidos, así que este flujo no puede vivir en ninguno de los dos; nadie importa este módulo.
 */
@Module({
  imports: [OrdersModule, CatalogModule, LogisticsModule],
  controllers: [PickingController],
  providers: [PickingService],
})
export class FulfillmentModule {}
