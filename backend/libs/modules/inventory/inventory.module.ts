import { forwardRef, Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { PurchaseOrdersController } from './api/purchase-orders.controller';
import { StockController } from './api/stock.controller';
import { SuppliersController } from './api/suppliers.controller';
import { WarehousesController } from './api/warehouses.controller';
import { CatalogVariants } from './application/catalog-variants';
import { InventoryApi } from './application/inventory.api';
import {
  PurchaseOrderRepository,
  ReservationRepository,
  StockRepository,
  SupplierRepository,
  WarehouseRepository,
} from './application/ports';
import { PurchaseOrderService } from './application/purchase-order.service';
import { ReservationService } from './application/reservation.service';
import { ReturnStockService } from './application/return-stock.service';
import { StockService } from './application/stock.service';
import { SupplierService } from './application/supplier.service';
import { WarehouseService } from './application/warehouse.service';
import { InventoryConsumer } from './infrastructure/consumers/inventory.consumer';
import { ReleaseExpiredReservationsJob } from './infrastructure/jobs/release-expired-reservations.job';
import { PgPurchaseOrderRepository } from './infrastructure/pg-purchase-order.repository';
import { PgReservationRepository } from './infrastructure/pg-reservation.repository';
import { PgStockRepository } from './infrastructure/pg-stock.repository';
import { PgSupplierRepository } from './infrastructure/pg-supplier.repository';
import { PgWarehouseRepository } from './infrastructure/pg-warehouse.repository';

/**
 * Módulo Inventario (schema inventory). Requiere que la app registre ConfigModule,
 * DatabaseModule y OutboxModule del shared kernel (son globales).
 */
@Module({
  // Catálogo: verificar que las variantes de ajustes y órdenes de compra sean del tenant.
  imports: [forwardRef(() => CatalogModule)], // ver CatalogVariants: ciclo de archivos con el storefront
  controllers: [WarehousesController, StockController, SuppliersController, PurchaseOrdersController],
  providers: [
    // Puertos → adaptadores PostgreSQL
    { provide: WarehouseRepository, useClass: PgWarehouseRepository },
    { provide: StockRepository, useClass: PgStockRepository },
    { provide: ReservationRepository, useClass: PgReservationRepository },
    { provide: SupplierRepository, useClass: PgSupplierRepository },
    { provide: PurchaseOrderRepository, useClass: PgPurchaseOrderRepository },
    // Casos de uso
    WarehouseService,
    StockService,
    ReservationService,
    SupplierService,
    PurchaseOrderService,
    ReturnStockService,
    CatalogVariants,
    InventoryApi,
  ],
  exports: [InventoryApi, ReservationService],
})
export class InventoryModule {}

/**
 * Parte del módulo que corre en el proceso worker: jobs de BullMQ. Requiere QueueModule.
 * Se separa para que la API no procese jobs (ADR-06: el worker es otro proceso).
 */
@Module({
  imports: [InventoryModule],
  providers: [ReleaseExpiredReservationsJob],
})
export class InventoryWorkerModule {}

/** Consumidores de eventos de Pedidos (proceso worker; en tests, junto con el relay). */
@Module({
  imports: [InventoryModule],
  providers: [InventoryConsumer],
})
export class InventoryConsumersModule {}
