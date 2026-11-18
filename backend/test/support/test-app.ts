import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../apps/api/app.module';
import { configureApp } from '../../apps/api/configure-app';
import { BillingConsumersModule } from '../../libs/modules/billing';
import { CrmConsumersModule } from '../../libs/modules/crm';
import { InventoryConsumersModule } from '../../libs/modules/inventory';
import { LogisticsConsumersModule } from '../../libs/modules/logistics';
import { NotificationsConsumersModule } from '../../libs/modules/notifications';
import { OrdersConsumersModule } from '../../libs/modules/orders';
import { PaymentsConsumersModule } from '../../libs/modules/payments';
import { PromotionsConsumersModule } from '../../libs/modules/promotions';
import { SupportConsumersModule } from '../../libs/modules/support';
import { Database, OutboxRelay } from '../../libs/shared-kernel';

/**
 * App HTTP completa (misma configuración que producción) contra la base de Testcontainers.
 * Con withConsumers, registra además los consumidores de eventos del worker (sin los jobs de
 * BullMQ): el test publica el outbox cuando quiere con relay.drain({ tenantId }).
 *
 * withBilling agrega el consumidor de Facturación (OrderPaid → factura). Va aparte porque exige
 * que el tenant tenga punto de emisión y secuencial (fixture createEmissionPoint).
 *
 * withNotifications agrega el consumidor de Notificaciones (canales en memoria, NOTIFICATION_TRANSPORT=memory).
 * Va aparte para que los demás archivos no encolen notificaciones que no verifican.
 *
 * withCrm agrega los consumidores del CRM (OrderDelivered → puntos y referidos, ReturnRefunded → reversa).
 *
 * withSupport agrega el consumidor de Soporte (InvoiceRejected → ticket interno).
 */
export async function createTestApp(opts: { withConsumers?: boolean; withBilling?: boolean; withNotifications?: boolean; withCrm?: boolean; withSupport?: boolean } = {}): Promise<{
  app: INestApplication;
  db: Database;
  relay: OutboxRelay;
}> {
  const consumers = opts.withConsumers
    ? [InventoryConsumersModule, OrdersConsumersModule, PromotionsConsumersModule, PaymentsConsumersModule, LogisticsConsumersModule]
    : [];
  if (opts.withBilling) consumers.push(BillingConsumersModule);
  if (opts.withNotifications) consumers.push(NotificationsConsumersModule);
  if (opts.withCrm) consumers.push(CrmConsumersModule);
  if (opts.withSupport) consumers.push(SupportConsumersModule);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, ...consumers] }).compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: ['error', 'warn'], rawBody: true }));
  await app.init();
  return { app, db: app.get(Database), relay: app.get(OutboxRelay) };
}
