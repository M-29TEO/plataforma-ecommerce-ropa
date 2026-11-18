/**
 * Puertos de persistencia del módulo Pedidos (schema sales). Mismo criterio que Inventario:
 * clases abstractas como tokens de Nest y Queryable de la transacción en curso.
 */
import { Queryable } from '../../../shared-kernel';
import { ActorType, Order, OrderChannel, OrderProps, PaymentStatus, StatusChange } from '../domain/order';
import { FulfillmentType, OrderStatus, PaymentMethod } from '../domain/order-status';
import { Return, ReturnStatus } from '../domain/return';

export interface OrderFilter {
  statuses?: OrderStatus[];
  paymentStatus?: PaymentStatus;
  paymentMethod?: PaymentMethod;
  fulfillmentType?: FulfillmentType;
  channel?: OrderChannel;
  userId?: string;
  /** Vendedor que tomó el pedido asistido (sales.orders.seller_id). */
  sellerId?: string;
  /** placed_at >= from */
  from?: Date;
  /** placed_at < to */
  to?: Date;
  /** Número de pedido exacto o parte del email del cliente. */
  search?: string;
  limit: number;
  offset: number;
}

/**
 * Línea de un pedido ENTREGADO de un cliente (compra verificada para reseñas). Solo las que
 * no se devolvieron completas.
 */
export interface DeliveredLine {
  orderId: string;
  orderItemId: string;
  productId: string;
  variantId: string;
  deliveredAt: Date;
}

/** Listados: cabecera sin líneas, con la cantidad de ítems. */
export type OrderSummary = Omit<OrderProps, 'items'> & { itemCount: number };

export interface StatusHistoryEntry {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorType: ActorType;
  actorId: string | null;
  reason: string | null;
  createdAt: Date;
}

export abstract class OrderRepository {
  /**
   * Inserta cabecera e ítems y asigna el número de pedido. Devuelve false si ya existe un
   * pedido con ese id (reintento de Checkout): en ese caso no escribe nada.
   */
  abstract insert(q: Queryable, order: Order): Promise<boolean>;
  abstract findById(q: Queryable, tenantId: string, id: string, opts?: { forUpdate?: boolean }): Promise<Order | null>;
  abstract list(q: Queryable, tenantId: string, filter: OrderFilter): Promise<OrderSummary[]>;
  /**
   * Concurrencia optimista: UPDATE ... WHERE version = expectedVersion. Devuelve false si
   * otra transacción cambió el pedido antes (0 filas). Si tiene éxito, actualiza version
   * y updated_at del agregado.
   */
  abstract update(q: Queryable, order: Order, expectedVersion: number): Promise<boolean>;
  abstract insertStatusChange(q: Queryable, change: StatusChange): Promise<void>;
  abstract listStatusHistory(q: Queryable, orderId: string): Promise<StatusHistoryEntry[]>;
  /** Persiste order_items.qty_returned de todas las líneas del pedido (tras Order.applyReturn). */
  abstract saveReturnedQuantities(q: Queryable, order: Order): Promise<void>;
  /** Líneas entregadas (y no devueltas completas) del cliente para esos productos, la más reciente primero. */
  abstract findDeliveredLines(q: Queryable, tenantId: string, userId: string, productIds: string[]): Promise<DeliveredLine[]>;
  /** Pedidos del cliente que no fueron cancelados. */
  abstract countActiveByUser(q: Queryable, tenantId: string, userId: string): Promise<number>;
  /** Cola de picking de bodega: los más antiguos primero (orden por placed_at). */
  abstract listFulfillmentQueue(q: Queryable, tenantId: string, filter: FulfillmentQueueFilter): Promise<FulfillmentQueueEntry[]>;
}

/**
 * Cola de picking. to_pick: listos para preparar según la máquina de estados (paid, o created
 * contra entrega); picking: en preparación (preparing).
 */
export interface FulfillmentQueueFilter {
  stage: 'to_pick' | 'picking';
  /** sales.orders.source_warehouse_id (bodega que despacha o tienda de retiro). */
  warehouseId?: string;
  limit: number;
}

/** Cabecera con la cantidad de líneas y de unidades a recoger. */
export type FulfillmentQueueEntry = OrderSummary & { unitCount: number };

export interface ReturnFilter {
  statuses?: ReturnStatus[];
  orderId?: string;
  /** Devoluciones de los pedidos de este cliente. */
  userId?: string;
  limit: number;
  offset: number;
}

/** Persistencia de sales.returns y sales.return_items. */
export abstract class ReturnRepository {
  abstract insert(q: Queryable, ret: Return): Promise<void>;
  abstract findById(q: Queryable, tenantId: string, id: string, opts?: { forUpdate?: boolean }): Promise<Return | null>;
  abstract list(q: Queryable, tenantId: string, filter: ReturnFilter): Promise<Return[]>;
  /**
   * Guarda estado, resolución, monto, aprobador, cierre y la inspección de las líneas, solo si la
   * fila sigue en expectedStatus (la tabla no tiene columna version). false si otro proceso la cambió.
   */
  abstract update(q: Queryable, ret: Return, expectedStatus: ReturnStatus): Promise<boolean>;
  /** Cuántas devoluciones tiene ya el pedido (para numerar el RMA). */
  abstract countByOrder(q: Queryable, orderId: string): Promise<number>;
  /** Unidades por línea del pedido que están en solicitudes abiertas (aún no inspeccionadas). */
  abstract openQuantities(q: Queryable, orderId: string): Promise<Map<string, number>>;
}
