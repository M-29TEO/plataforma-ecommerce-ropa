import { Module } from '@nestjs/common';
import { BillingConsumersModule, BillingWorkerModule } from '../../libs/modules/billing';
import { CartWorkerModule } from '../../libs/modules/cart';
import { CrmConsumersModule, CrmWorkerModule } from '../../libs/modules/crm';
import { InventoryConsumersModule, InventoryWorkerModule } from '../../libs/modules/inventory';
import { LogisticsConsumersModule, LogisticsWorkerModule } from '../../libs/modules/logistics';
import { NotificationsConsumersModule, NotificationsWorkerModule } from '../../libs/modules/notifications';
import { OrdersConsumersModule } from '../../libs/modules/orders';
import { PaymentsConsumersModule, PaymentsWorkerModule } from '../../libs/modules/payments';
import { PromotionsConsumersModule } from '../../libs/modules/promotions';
import { ReportsWorkerModule } from '../../libs/modules/reports';
import { SupportConsumersModule, SupportWorkerModule } from '../../libs/modules/support';
import {
  AuditWorkerModule,
  ConfigModule,
  DatabaseModule,
  ObservabilityModule,
  OutboxModule,
  OutboxRelayWorkerModule,
  QueueMetricsModule,
  QueueModule,
  RealtimePublisherModule,
} from '../../libs/shared-kernel';

/**
 * Proceso worker: jobs de BullMQ (reservas y pagos vencidos, franjas de entrega, liquidaciones semanales de motorizados, comprobantes del SRI, carrito abandonado, despacho de notificaciones, puntos, referidos y alertas de wishlist, SLA y cierre de tickets de soporte, refresco de las vistas de reportes y exportes Excel/PDF, particiones mensuales de la auditoría, relay del outbox) y los consumidores
 * de eventos de dominio que el relay invoca. Reporta la profundidad de las colas (QueueMetricsModule).
 */
@Module({
  imports: [
    ConfigModule.forRoot(),
    DatabaseModule,
    OutboxModule,
    RealtimePublisherModule,
    QueueModule,
    ObservabilityModule,
    QueueMetricsModule,
    OutboxRelayWorkerModule,
    AuditWorkerModule,
    InventoryWorkerModule,
    PaymentsWorkerModule,
    LogisticsWorkerModule,
    BillingWorkerModule,
    CartWorkerModule,
    NotificationsWorkerModule,
    CrmWorkerModule,
    SupportWorkerModule,
    ReportsWorkerModule,
    InventoryConsumersModule,
    OrdersConsumersModule,
    PromotionsConsumersModule,
    PaymentsConsumersModule,
    LogisticsConsumersModule,
    BillingConsumersModule,
    NotificationsConsumersModule,
    CrmConsumersModule,
    SupportConsumersModule,
  ],
})
export class WorkerModule {}
