import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AftersalesModule } from '../../libs/modules/aftersales';
import { BillingModule } from '../../libs/modules/billing';
import { CartModule } from '../../libs/modules/cart';
import { CatalogModule, CatalogReviewsModule } from '../../libs/modules/catalog';
import { CheckoutModule } from '../../libs/modules/checkout';
import { CrmModule } from '../../libs/modules/crm';
import { IamModule } from '../../libs/modules/iam';
import { InventoryModule } from '../../libs/modules/inventory';
import { LogisticsModule } from '../../libs/modules/logistics';
import { NotificationsModule } from '../../libs/modules/notifications';
import { OrdersModule } from '../../libs/modules/orders';
import { PaymentsModule } from '../../libs/modules/payments';
import { PrivacyModule } from '../../libs/modules/privacy';
import { PromotionsModule } from '../../libs/modules/promotions';
import { ReportsModule } from '../../libs/modules/reports';
import { StorefrontModule } from '../../libs/modules/storefront';
import { FulfillmentModule } from '../../libs/modules/fulfillment';
import { SupportModule } from '../../libs/modules/support';
import {
  ConfigModule,
  DatabaseModule,
  GlobalAuthGuard,
  ObservabilityModule,
  OutboxModule,
  PermissionGuard,
  RealtimePublisherModule,
  SecurityModule,
} from '../../libs/shared-kernel';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot(),
    ObservabilityModule,
    DatabaseModule,
    OutboxModule,
    RealtimePublisherModule,
    // Rate limiting (Valkey) y auditoría automática; su APP_GUARD corre antes que los de autenticación.
    SecurityModule,
    IamModule,
    CatalogModule,
    InventoryModule,
    OrdersModule,
    PromotionsModule,
    CartModule,
    PaymentsModule,
    LogisticsModule,
    BillingModule,
    CheckoutModule,
    AftersalesModule,
    CrmModule,
    CatalogReviewsModule,
    StorefrontModule,
    FulfillmentModule,
    NotificationsModule,
    SupportModule,
    ReportsModule,
    PrivacyModule,
  ],
  controllers: [HealthController],
  // Cerrado por defecto: toda ruta exige JWT salvo @Public() / @OptionalAuth(). Después, RBAC:
  // @RequirePermission(...) contra los permisos del JWT. Los APP_GUARD corren en este orden.
  providers: [
    { provide: APP_GUARD, useClass: GlobalAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule {}
