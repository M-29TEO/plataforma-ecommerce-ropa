/**
 * API PÚBLICA del módulo Pedidos. Otros módulos solo pueden importar desde aquí
 * (nunca desde domain/, application/ o infrastructure/).
 */
export { OrdersConsumersModule, OrdersModule } from './orders.module';
export { OrdersApi } from './application/orders.api';
export type { OrderDetail } from './application/order.service';
export type { DeliveredLine, OrderFilter, OrderSummary, ReturnFilter, StatusHistoryEntry } from './application/ports';
export type { FulfillmentQueueEntry, FulfillmentQueueFilter } from './application/ports';
export type { ReturnDetail, ReturnLineView, ReturnOrderInfo } from './application/return.service';
export type {
  Actor,
  ActorType,
  CustomerSnapshot,
  NewOrder,
  NewOrderItem,
  OrderChannel,
  OrderItem,
  OrderProps,
  PaymentStatus,
} from './domain/order';
export { canTransition, MANUAL_STATUSES, ORDER_STATUSES } from './domain/order-status';
export type { FulfillmentType, OrderStatus, PaymentMethod } from './domain/order-status';
export * from './events';
export {
  ITEM_CONDITIONS,
  MAX_PHOTOS_PER_ITEM,
  REFUND_RESOLUTIONS,
  RETURN_REASON_CODES,
  RETURN_STATUSES,
  RETURN_TYPES,
} from './domain/return';
export type {
  ItemCondition,
  ItemInspection,
  NewReturn,
  NewReturnItem,
  ReturnItem,
  ReturnProps,
  ReturnReasonCode,
  ReturnResolution,
  ReturnStatus,
  ReturnType,
} from './domain/return';
export {
  RETURN_APPROVED,
  RETURN_EXCHANGED,
  RETURN_INSPECTED,
  RETURN_RECEIVED,
  RETURN_REFUNDED,
  RETURN_REJECTED,
  RETURN_REQUESTED,
} from './domain/return-events';
export type { ReturnEventPayload, ReturnItemPayload } from './domain/return-events';
export {
  CustomerCannotTransitionError,
  InvalidOrderError,
  InvalidOrderTransitionError,
  InvalidReturnError,
  InvalidReturnTransitionError,
  OrderNotFoundError,
  ReasonRequiredError,
  ReturnNotAllowedError,
  ReturnNotFoundError,
  StaleOrderVersionError,
} from './domain/errors';
