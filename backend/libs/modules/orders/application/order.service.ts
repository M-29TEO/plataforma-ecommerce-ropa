import { Injectable } from '@nestjs/common';
import { Database, OutboxWriter, Queryable } from '../../../shared-kernel';
import { OrderNotFoundError, StaleOrderVersionError } from '../domain/errors';
import { orderPlaced } from '../domain/events';
import { Actor, NewOrder, Order, OrderProps } from '../domain/order';
import { OrderStatus } from '../domain/order-status';
import { DeliveredLine, FulfillmentQueueEntry, FulfillmentQueueFilter, OrderFilter, OrderRepository, OrderSummary, StatusHistoryEntry } from './ports';

export interface ChangeStatusInput {
  to: OrderStatus;
  actor: Actor;
  reason?: string | null;
  /**
   * Versión que leyó el cliente (concurrencia optimista). Los procesos del sistema que no
   * la conocen (por ejemplo, el consumidor de PaymentCaptured) la omiten y se usa la actual.
   */
  expectedVersion?: number;
  /** Restringe el cambio a los pedidos de este usuario (endpoints del cliente). */
  ownerId?: string;
}

export type OrderDetail = OrderProps & { history: StatusHistoryEntry[] };

@Injectable()
export class OrderService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrderRepository,
    private readonly outbox: OutboxWriter,
  ) {}

  /**
   * Crea el pedido en created: cabecera, ítems con snapshots, historial (null → created) y
   * OrderPlaced en el outbox, todo en una transacción. Es idempotente por id: si Checkout
   * reintenta con el mismo id, devuelve el pedido existente sin duplicar eventos.
   */
  async place(input: NewOrder, actor: Actor): Promise<OrderProps> {
    const order = Order.place(input);
    return this.db.withTransaction(async (tx) => {
      const inserted = await this.orders.insert(tx, order);
      if (!inserted) {
        const existing = await this.orders.findById(tx, input.tenantId, order.id);
        if (!existing) throw new OrderNotFoundError(order.id); // el id existe, pero en otro tenant
        return existing.toJSON();
      }
      await this.orders.insertStatusChange(tx, order.placedChange(actor));
      await this.outbox.append(tx, [orderPlaced(order.toJSON())]);
      return order.toJSON();
    });
  }

  /**
   * Cambio de estado en una transacción: valida contra la máquina de estados, actualiza el
   * pedido con version condicional, agrega la fila de historial y encola los eventos.
   * Una transición inválida lanza antes de escribir nada.
   */
  changeStatus(tenantId: string, orderId: string, input: ChangeStatusInput): Promise<OrderProps> {
    return this.applyTransition(tenantId, orderId, input);
  }

  /**
   * Pago capturado (desde Pagos o confirmación manual). Idempotente: si el pedido ya está
   * pagado, lo devuelve sin cambios, porque los eventos pueden entregarse más de una vez.
   * Se verifica con la fila bloqueada, así dos entregas simultáneas no terminan en error.
   */
  markPaid(tenantId: string, orderId: string, actor: Actor): Promise<OrderProps> {
    return this.applyTransition(tenantId, orderId, { to: 'paid', actor }, (o) => o.paymentStatus === 'paid');
  }

  /**
   * El pago falló o venció: payment_status → failed y cancela el pedido, solo si sigue en created. Si ya avanzó
   * (pagado por otra vía, ya cancelado), no hace nada: los eventos pueden llegar tarde o repetidos.
   */
  cancelUnpaid(tenantId: string, orderId: string, reason: string, actor: Actor): Promise<OrderProps> {
    return this.applyTransition(
      tenantId,
      orderId,
      { to: 'cancelled', actor, reason },
      (o) => o.status !== 'created',
      (o) => o.recordPaymentFailure(),
    );
  }

  private applyTransition(
    tenantId: string,
    orderId: string,
    input: ChangeStatusInput,
    alreadyApplied?: (order: Order) => boolean,
    /** Cambios del agregado que acompañan a la transición (misma fila, misma versión). */
    prepare?: (order: Order) => void,
  ): Promise<OrderProps> {
    return this.db.withTransaction(async (tx) => {
      // Sin versión del cliente (procesos del sistema) se bloquea la fila: no hay con qué detectar el conflicto.
      const order = await this.load(tx, tenantId, orderId, input.ownerId, input.expectedVersion === undefined);
      if (alreadyApplied?.(order)) return order.toJSON();
      const expected = input.expectedVersion ?? order.version;
      if (expected !== order.version) throw new StaleOrderVersionError(orderId, expected, order.version);

      prepare?.(order);
      const { change, events } = order.transitionTo(input.to, input.actor, input.reason);
      if (!(await this.orders.update(tx, order, expected))) throw new StaleOrderVersionError(orderId, expected);
      await this.orders.insertStatusChange(tx, change);
      await this.outbox.append(tx, events);
      return order.toJSON();
    });
  }

  async get(tenantId: string, orderId: string, ownerId?: string): Promise<OrderDetail> {
    const order = await this.load(this.db, tenantId, orderId, ownerId);
    return { ...order.toJSON(), history: await this.orders.listStatusHistory(this.db, orderId) };
  }

  async history(tenantId: string, orderId: string, ownerId?: string): Promise<StatusHistoryEntry[]> {
    await this.load(this.db, tenantId, orderId, ownerId);
    return this.orders.listStatusHistory(this.db, orderId);
  }

  list(tenantId: string, filter: OrderFilter): Promise<OrderSummary[]> {
    return this.orders.list(this.db, tenantId, { ...filter, limit: Math.min(Math.max(filter.limit, 1), 100) });
  }

  deliveredLines(tenantId: string, userId: string, productIds: string[]): Promise<DeliveredLine[]> {
    return this.orders.findDeliveredLines(this.db, tenantId, userId, [...new Set(productIds)]);
  }

  countActiveByUser(tenantId: string, userId: string): Promise<number> {
    return this.orders.countActiveByUser(this.db, tenantId, userId);
  }

  fulfillmentQueue(tenantId: string, filter: FulfillmentQueueFilter): Promise<FulfillmentQueueEntry[]> {
    return this.orders.listFulfillmentQueue(this.db, tenantId, { ...filter, limit: Math.min(Math.max(filter.limit, 1), 1000) });
  }

  /** Un pedido de otro cliente se reporta como inexistente (no se revela que existe). */
  private async load(q: Queryable, tenantId: string, orderId: string, ownerId?: string, forUpdate = false): Promise<Order> {
    const order = await this.orders.findById(q, tenantId, orderId, { forUpdate });
    if (!order || (ownerId !== undefined && order.userId !== ownerId)) throw new OrderNotFoundError(orderId);
    return order;
  }
}
