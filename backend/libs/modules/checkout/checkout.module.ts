import { Module } from '@nestjs/common';
import { BillingModule } from '../billing';
import { CartModule } from '../cart';
import { CatalogModule } from '../catalog';
import { CrmModule } from '../crm';
import { IamModule } from '../iam';
import { InventoryModule } from '../inventory';
import { LogisticsModule } from '../logistics';
import { OrdersModule } from '../orders';
import { PaymentsModule } from '../payments';
import { PromotionsModule } from '../promotions';
import { AssistedOrdersController } from './api/assisted-orders.controller';
import { CheckoutController } from './api/checkout.controller';
import { AssistedOrderService } from './application/assisted-order.service';
import { CheckoutService } from './application/checkout.service';

/**
 * Módulo Checkout: orquestador sin schema propio. Usa solo las fachadas públicas (index.ts) de
 * Carrito, Catálogo, Inventario, Logística, Promociones, Pedidos, Pagos, Facturación, CRM e IAM.
 * Incluye los pedidos asistidos del backoffice (mismo flujo de pedido y pago, sin carrito).
 */
@Module({
  imports: [CartModule, CatalogModule, InventoryModule, LogisticsModule, PromotionsModule, OrdersModule, PaymentsModule, BillingModule, CrmModule, IamModule],
  controllers: [CheckoutController, AssistedOrdersController],
  providers: [CheckoutService, AssistedOrderService],
})
export class CheckoutModule {}
