import { Module } from '@nestjs/common';
import { MyOrdersController } from './api/my-orders.controller';
import { OrdersController } from './api/orders.controller';
import { OrderService } from './application/order.service';
import { OrdersApi } from './application/orders.api';
import { OrderRepository, ReturnRepository } from './application/ports';
import { ReturnService } from './application/return.service';
import { OrdersConsumer } from './infrastructure/consumers/orders.consumer';
import { PgOrderRepository } from './infrastructure/pg-order.repository';
import { PgReturnRepository } from './infrastructure/pg-return.repository';
import { OrdersPersonalDataContributor } from './infrastructure/personal-data.contributor';

/**
 * Módulo Pedidos (schema sales: orders, order_items, order_status_history, returns, return_items). Requiere que la
 * app registre ConfigModule, DatabaseModule y OutboxModule del shared kernel (son globales).
 *
 * No llama a Inventario: sus efectos (confirmar, liberar o reponer stock) se disparan con
 * los eventos OrderPlaced / OrderPaid / OrderCancelled del outbox (ADR-05), así un pedido
 * nunca queda a medias entre dos transacciones.
 */
@Module({
  controllers: [MyOrdersController, OrdersController],
  providers: [
    { provide: OrderRepository, useClass: PgOrderRepository },
    { provide: ReturnRepository, useClass: PgReturnRepository },
    OrderService,
    ReturnService,
    OrdersApi,
    OrdersPersonalDataContributor,
  ],
  // Los servicios se exportan solo para OrdersConsumersModule (index.ts no los expone).
  exports: [OrdersApi, OrderService, ReturnService],
})
export class OrdersModule {}

/** Consumidores de eventos de Pagos (pagos y reembolsos; proceso worker; en tests, junto con el relay). */
@Module({ imports: [OrdersModule], providers: [OrdersConsumer] })
export class OrdersConsumersModule {}
