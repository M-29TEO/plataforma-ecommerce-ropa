import { Injectable } from '@nestjs/common';
import { Actor, NewOrder, OrderProps } from '../domain/order';
import { OrderStatus } from '../domain/order-status';
import { ItemInspection, NewReturn, ReturnProps } from '../domain/return';
import { OrderDetail, OrderService } from './order.service';
import { DeliveredLine, FulfillmentQueueEntry, FulfillmentQueueFilter, OrderFilter, OrderSummary, ReturnFilter } from './ports';
import { ReturnDetail, ReturnService } from './return.service';

const SYSTEM: Actor = { type: 'system', id: null };

/**
 * Fachada síncrona para otros módulos. Checkout crea pedidos con placeOrder (los precios y
 * snapshots vienen del catálogo, por eso no hay POST público); Pagos y Logística avanzan el
 * estado con markPaid / changeStatus al consumir sus eventos.
 */
@Injectable()
export class OrdersApi {
  constructor(
    private readonly orders: OrderService,
    private readonly returns: ReturnService,
  ) {}

  /** Idempotente por input.id. Lanza ValidationError si las líneas o los montos no cuadran. */
  placeOrder(input: NewOrder, actor: Actor = SYSTEM): Promise<OrderProps> {
    return this.orders.place(input, actor);
  }

  /** PaymentCaptured → paid. Idempotente. */
  markPaid(tenantId: string, orderId: string, actor: Actor = SYSTEM): Promise<OrderProps> {
    return this.orders.markPaid(tenantId, orderId, actor);
  }

  /** PaymentFailed / PaymentExpired → cancelled, solo si el pedido sigue sin pagar. Idempotente. */
  cancelUnpaidOrder(tenantId: string, orderId: string, reason: string, actor: Actor = SYSTEM): Promise<OrderProps> {
    return this.orders.cancelUnpaid(tenantId, orderId, reason, actor);
  }

  /** ShipmentStatusChanged, etc. Sin versión: usa la actual con bloqueo de fila. */
  changeStatus(tenantId: string, orderId: string, to: OrderStatus, actor: Actor = SYSTEM, reason?: string): Promise<OrderProps> {
    return this.orders.changeStatus(tenantId, orderId, { to, actor, reason });
  }

  getOrder(tenantId: string, orderId: string): Promise<OrderDetail> {
    return this.orders.get(tenantId, orderId);
  }

  /** Listado de cabeceras (sin líneas) con filtros; limit se acota a 1..100. */
  listOrders(tenantId: string, filter: OrderFilter): Promise<OrderSummary[]> {
    return this.orders.list(tenantId, filter);
  }

  /** Por número visible (soporte a invitados: "pedido #100123"). null si no existe. */
  async findOrderByNumber(tenantId: string, orderNumber: string): Promise<OrderDetail | null> {
    if (!/^\d{1,18}$/.test(orderNumber)) return null;
    const [found] = await this.orders.list(tenantId, { search: orderNumber, limit: 1, offset: 0 });
    return found && found.orderNumber === orderNumber ? this.orders.get(tenantId, found.id) : null;
  }

  // ------------------------------------------------------------------ devoluciones y cambios
  // Las usa el orquestador de posventa, que compone cada paso con Logística, Inventario y Pagos.

  /** ownerId: el pedido debe ser de ese cliente (si no, 404). */
  requestReturn(input: NewReturn, actor: Actor, ownerId?: string): Promise<ReturnDetail> {
    return this.returns.request(input, actor, ownerId);
  }

  approveReturn(tenantId: string, returnId: string, approverId: string): Promise<ReturnDetail> {
    return this.returns.approve(tenantId, returnId, approverId);
  }

  rejectReturn(tenantId: string, returnId: string, actorId: string, reason: string): Promise<ReturnDetail> {
    return this.returns.reject(tenantId, returnId, actorId, reason);
  }

  /** Idempotente. */
  markReturnPickupScheduled(tenantId: string, returnId: string): Promise<ReturnDetail> {
    return this.returns.markPickupScheduled(tenantId, returnId);
  }

  receiveReturn(tenantId: string, returnId: string, actorId: string): Promise<ReturnDetail> {
    return this.returns.receive(tenantId, returnId, actorId);
  }

  inspectReturn(tenantId: string, returnId: string, actor: Actor, inspections: ItemInspection[]): Promise<ReturnDetail> {
    return this.returns.inspect(tenantId, returnId, actor, inspections);
  }

  /** Idempotente. */
  markReturnExchanged(tenantId: string, returnId: string): Promise<ReturnDetail> {
    return this.returns.markExchanged(tenantId, returnId);
  }

  /** ownerId: solo si la devolución es de un pedido de ese cliente (si no, 404). */
  getReturn(tenantId: string, returnId: string, ownerId?: string): Promise<ReturnDetail> {
    return this.returns.get(tenantId, returnId, ownerId);
  }

  listReturns(tenantId: string, filter: ReturnFilter): Promise<ReturnProps[]> {
    return this.returns.list(tenantId, filter);
  }

  /** Compra verificada (reseñas): líneas entregadas del cliente para esos productos, la más reciente primero. */
  findDeliveredLines(tenantId: string, userId: string, productIds: string[]): Promise<DeliveredLine[]> {
    return this.orders.deliveredLines(tenantId, userId, productIds);
  }

  /** Pedidos no cancelados del cliente (referidos: el código es solo para quien aún no compró). */
  countActiveOrders(tenantId: string, userId: string): Promise<number> {
    return this.orders.countActiveByUser(tenantId, userId);
  }

  // ------------------------------------------------------------------ picking de bodega
  // Los usa el orquestador fulfillment, que junta el pedido con Catálogo y Logística.

  /** Pedidos por preparar (to_pick) o en preparación (picking) de una bodega, los más antiguos primero. Tope 1000. */
  listFulfillmentQueue(tenantId: string, filter: FulfillmentQueueFilter): Promise<FulfillmentQueueEntry[]> {
    return this.orders.fulfillmentQueue(tenantId, filter);
  }

  /** Cambio de estado con la versión que leyó el operador: StaleOrderVersionError (409) si cambió. */
  changeStatusAtVersion(tenantId: string, orderId: string, to: OrderStatus, expectedVersion: number, actor: Actor): Promise<OrderProps> {
    return this.orders.changeStatus(tenantId, orderId, { to, actor, expectedVersion });
  }
}
