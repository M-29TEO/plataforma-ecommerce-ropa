/**
 * API PÚBLICA del módulo Inventario. Otros módulos solo pueden importar desde aquí
 * (nunca desde domain/, application/ o infrastructure/).
 */
export { InventoryConsumersModule, InventoryModule, InventoryWorkerModule } from './inventory.module';
export { InventoryApi } from './application/inventory.api';
export type { ShippingWarehouse } from './application/inventory.api';
export type { ReserveStockInput, ReserveStockResult } from './application/reservation.service';
export type { ExchangeIssueInput, RestockReturnInput } from './application/return-stock.service';
export type { Reservation, ReservationLine, ReservationStatus } from './domain/reservation';
export { STOCK_BELOW_THRESHOLD } from './domain/events';
export type { StockBelowThresholdPayload } from './domain/events';
export type { AllocationItem } from './domain/allocation';
export { AllocationShortageError } from './domain/allocation';
export {
  InsufficientStockError,
  OrderAlreadyReservedError,
  ReservationExpiredError,
  ReservationNotFoundError,
  WarehouseInactiveError,
} from './domain/errors';
