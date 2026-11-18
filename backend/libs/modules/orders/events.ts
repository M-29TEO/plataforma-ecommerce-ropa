/**
 * Contratos de eventos del módulo Pedidos (nombres y payloads): segunda API pública, sin dependencias de
 * Nest ni de la base. La usan los consumidores de otros módulos para suscribirse sin cargar el módulo
 * entero, así dos módulos pueden escuchar los eventos del otro sin formar un ciclo de imports.
 */
export { ORDER_CANCELLED, ORDER_DELIVERED, ORDER_PAID, ORDER_PLACED } from './domain/events';
export type {
  OrderCancelledPayload,
  OrderDeliveredPayload,
  OrderLinePayload,
  OrderPaidPayload,
  OrderPlacedPayload,
} from './domain/events';
