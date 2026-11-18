/**
 * API PÚBLICA del módulo Logística. Otros módulos solo pueden importar desde aquí
 * (nunca desde domain/, application/ o infrastructure/).
 */
export { LogisticsConsumersModule, LogisticsModule, LogisticsRealtimeModule, LogisticsWorkerModule } from './logistics.module';
export { TrackingTokenResolver } from './application/tracking-token.resolver';
export type { ResolvedTracking } from './application/tracking-token.resolver';
export { orderRoom, REALTIME_EVENTS, ridersRoom, STAFF_EVENTS, STAFF_NAMESPACE } from './domain/tracking';
export { LogisticsApi } from './application/logistics.api';
export type {
  BookDeliveryInput,
  DeliveryDestination,
  DeliveryOptionView,
  DeliveryQuote,
  DeliveryQuoteInput,
  ResolveDeliveryInput,
  ResolvedDelivery,
  RiderSlotOption,
} from './application/delivery-quote.service';
export type { ShipmentDirection, ShipmentSummary } from './application/ports';
export type { OutboundShipmentInfo } from './application/handoff-ports';
export type { HandoffResult, ReadyForPickupInput } from './application/handoff.service';
export type {
  ExchangeShipmentInput,
  ReturnPickupInput,
  ReverseShipmentItem,
  ReverseShipmentResult,
} from './application/reverse-logistics.service';
export type { CourierReason } from './domain/delivery-rules';
export { VOLUMETRIC_DIVISOR } from './domain/rider-pricing';
export {
  DeliveryQuoteExpiredError,
  DeliveryQuoteInvalidError,
  DeliveryQuoteMismatchError,
  DeliverySlotRequiredError,
  NoDeliveryCoverageError,
  SlotUnavailableError,
} from './domain/errors';
export {
  CUSTOMER_RATED,
  RIDER_COD_LIMIT_EXCEEDED,
  RIDER_RATED,
  RIDER_SETTLEMENT_APPROVED,
  RIDER_SETTLEMENT_DISPUTED,
  RIDER_SETTLEMENT_DRAFTED,
  RIDER_SETTLEMENT_PAID,
  SHIPMENT_STATUS_CHANGED,
} from './domain/events';
export type {
  CustomerRatedPayload,
  RiderCodLimitExceededPayload,
  RiderRatedPayload,
  RiderSettlementPayload,
  ShipmentStatusChangedPayload,
} from './domain/events';
