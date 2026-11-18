import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, DomainEvent, OutboxWriter, Queryable } from '../../../shared-kernel';
import { OrderNotFoundError, ReturnNotFoundError, StaleOrderVersionError } from '../domain/errors';
import { Actor, CustomerSnapshot, GeoPoint, Order, OrderProps } from '../domain/order';
import { FulfillmentType, OrderStatus, PaymentMethod } from '../domain/order-status';
import { ItemInspection, NewReturn, Return, ReturnLineAmount, ReturnProps, ReturnStatus } from '../domain/return';
import {
  RETURN_APPROVED,
  RETURN_EXCHANGED,
  RETURN_INSPECTED,
  RETURN_RECEIVED,
  RETURN_REFUNDED,
  RETURN_REJECTED,
  RETURN_REQUESTED,
  returnEvent,
} from '../domain/return-events';
import { OrderRepository, ReturnFilter, ReturnRepository } from './ports';

/** Línea de la devolución con el snapshot del producto y su valor. */
export interface ReturnLineView extends ReturnLineAmount {
  returnItemId: string;
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  colorName: string | null;
  sizeCode: string | null;
  /** Bodega de la que salió la unidad vendida. */
  warehouseId: string | null;
  reasonCode: string;
  condition: string | null;
  restock: boolean | null;
  exchangeVariantId: string | null;
  photos: string[];
}

/** Lo que otros módulos necesitan del pedido para retirar, reembolsar o facturar la devolución. */
export interface ReturnOrderInfo {
  orderNumber: string;
  userId: string | null;
  status: OrderStatus;
  customer: CustomerSnapshot;
  billing: Record<string, unknown>;
  paymentMethod: PaymentMethod;
  fulfillmentType: FulfillmentType;
  shippingAddress: Record<string, unknown> | null;
  shippingLocation: GeoPoint | null;
  shippingCity: string | null;
  sourceWarehouseId: string | null;
}

export type ReturnDetail = Omit<ReturnProps, 'items'> & { order: ReturnOrderInfo; lines: ReturnLineView[] };

/**
 * Casos de uso de devoluciones y cambios (schema sales). Cada operación bloquea la fila de la
 * devolución (y la del pedido cuando lo modifica), valida la transición en el agregado y guarda
 * los eventos en el outbox en la misma transacción. Los efectos en otros módulos (retiro, stock,
 * reembolso, envío de la talla nueva) los compone el orquestador de posventa sobre OrdersApi.
 */
@Injectable()
export class ReturnService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrderRepository,
    private readonly returns: ReturnRepository,
    private readonly outbox: OutboxWriter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Solicitud del cliente (ownerId: solo sobre sus pedidos). El RMA se numera con el pedido bloqueado. */
  request(input: NewReturn, actor: Actor, ownerId?: string, now = new Date()): Promise<ReturnDetail> {
    return this.db.withTransaction(async (tx) => {
      const order = await this.orders.findById(tx, input.tenantId, input.orderId, { forUpdate: true });
      if (!order || (ownerId !== undefined && order.userId !== ownerId)) throw new OrderNotFoundError(input.orderId);
      const props = order.toJSON();
      const seq = (await this.returns.countByOrder(tx, order.id)) + 1;
      const ret = Return.request(input, {
        order: props,
        openQuantities: await this.returns.openQuantities(tx, order.id),
        windowDays: this.config.aftersales.returnWindowDays,
        rmaNumber: `RMA-${props.orderNumber}-${seq}`,
        photosOptional: actor.type === 'staff',
        now,
      });
      await this.returns.insert(tx, ret);
      await this.outbox.append(tx, [this.event(RETURN_REQUESTED, ret, props, actor.id)]);
      return this.detail(ret, props);
    });
  }

  approve(tenantId: string, returnId: string, approverId: string): Promise<ReturnDetail> {
    return this.mutate(tenantId, returnId, (ret) => {
      ret.approve(approverId);
      return { eventType: RETURN_APPROVED, actorId: approverId };
    });
  }

  reject(tenantId: string, returnId: string, actorId: string, reason: string): Promise<ReturnDetail> {
    return this.mutate(tenantId, returnId, (ret) => {
      const rejectionReason = ret.reject(reason);
      return { eventType: RETURN_REJECTED, actorId, rejectionReason };
    });
  }

  /** Logística creó el envío de retiro. Idempotente, sin evento propio (el retiro ya es visible en Logística). */
  markPickupScheduled(tenantId: string, returnId: string): Promise<ReturnDetail> {
    return this.mutate(tenantId, returnId, (ret) => (ret.schedulePickup() ? {} : null));
  }

  receive(tenantId: string, returnId: string, actorId: string): Promise<ReturnDetail> {
    return this.mutate(tenantId, returnId, (ret) => {
      ret.receive();
      return { eventType: RETURN_RECEIVED, actorId };
    });
  }

  /**
   * Inspección en bodega. En una devolución, las unidades pasan a qty_returned y el pedido a
   * partially_returned o returned (con su fila de historial), en la misma transacción. Un cambio
   * no toca el pedido: el cliente conserva la línea, ahora con otra talla.
   */
  inspect(tenantId: string, returnId: string, actor: Actor, inspections: ItemInspection[], now = new Date()): Promise<ReturnDetail> {
    return this.db.withTransaction(async (tx) => {
      const ret = await this.load(tx, tenantId, returnId, undefined, true);
      const order = await this.lockOrder(tx, tenantId, ret.orderId);
      const before = ret.status;
      ret.inspect(inspections, order.toJSON(), now);
      await this.save(tx, ret, before);
      const events: DomainEvent[] = [];
      if (ret.type === 'return') {
        const version = order.version;
        const transition = order.applyReturn(
          ret.toJSON().items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
          ret.rmaNumber,
          actor,
          now,
        );
        if (!(await this.orders.update(tx, order, version))) throw new StaleOrderVersionError(order.id, version);
        await this.orders.saveReturnedQuantities(tx, order);
        if (transition) {
          await this.orders.insertStatusChange(tx, transition.change);
          events.push(...transition.events);
        }
      }
      const props = order.toJSON();
      events.push(this.event(RETURN_INSPECTED, ret, props, actor.id));
      await this.outbox.append(tx, events);
      return this.detail(ret, props);
    });
  }

  /**
   * Pagos confirmó un reembolso (RefundSucceeded): la devolución queda refunded y el pedido
   * partially_refunded o refunded según lo reembolsado en total. Idempotente.
   */
  recordRefund(tenantId: string, input: { orderId: string; returnId: string | null; orderRefundedTotal: string }): Promise<void> {
    return this.db.withTransaction(async (tx) => {
      const order = await this.lockOrder(tx, tenantId, input.orderId);
      const events: DomainEvent[] = [];
      if (input.returnId) {
        const ret = await this.load(tx, tenantId, input.returnId, undefined, true);
        const before = ret.status;
        if (ret.markRefunded()) {
          await this.save(tx, ret, before);
          events.push(this.event(RETURN_REFUNDED, ret, order.toJSON(), null));
        }
      }
      const version = order.version;
      if (order.recordRefund(input.orderRefundedTotal) && !(await this.orders.update(tx, order, version))) {
        throw new StaleOrderVersionError(order.id, version);
      }
      await this.outbox.append(tx, events);
    });
  }

  /** Logística creó el envío con la variante nueva. Idempotente. */
  markExchanged(tenantId: string, returnId: string): Promise<ReturnDetail> {
    return this.mutate(tenantId, returnId, (ret) => (ret.markExchanged() ? { eventType: RETURN_EXCHANGED } : null));
  }

  async get(tenantId: string, returnId: string, ownerId?: string): Promise<ReturnDetail> {
    const ret = await this.load(this.db, tenantId, returnId, ownerId);
    const order = await this.orders.findById(this.db, tenantId, ret.orderId);
    if (!order) throw new OrderNotFoundError(ret.orderId);
    return this.detail(ret, order.toJSON());
  }

  async list(tenantId: string, filter: ReturnFilter): Promise<ReturnProps[]> {
    const limit = Math.min(Math.max(filter.limit, 1), 100);
    return (await this.returns.list(this.db, tenantId, { ...filter, limit })).map((r) => r.toJSON());
  }

  /**
   * Transición simple sobre la devolución bloqueada. fn devuelve el evento a publicar, {} para
   * guardar sin evento o null si no hubo cambio (operación idempotente repetida).
   */
  private mutate(
    tenantId: string,
    returnId: string,
    fn: (ret: Return) => { eventType?: string; actorId?: string | null; rejectionReason?: string } | null,
  ): Promise<ReturnDetail> {
    return this.db.withTransaction(async (tx) => {
      const ret = await this.load(tx, tenantId, returnId, undefined, true);
      const order = await this.orders.findById(tx, tenantId, ret.orderId);
      if (!order) throw new OrderNotFoundError(ret.orderId);
      const before = ret.status;
      const outcome = fn(ret);
      if (outcome) {
        await this.save(tx, ret, before);
        if (outcome.eventType) {
          await this.outbox.append(tx, [
            this.event(outcome.eventType, ret, order.toJSON(), outcome.actorId ?? null, outcome.rejectionReason),
          ]);
        }
      }
      return this.detail(ret, order.toJSON());
    });
  }

  private async save(tx: Queryable, ret: Return, expected: ReturnStatus): Promise<void> {
    // La fila está bloqueada (FOR UPDATE): el estado no puede haber cambiado entre la lectura y aquí.
    if (!(await this.returns.update(tx, ret, expected))) throw new Error(`La devolución ${ret.id} cambió durante la operación`);
  }

  private async load(q: Queryable, tenantId: string, returnId: string, ownerId?: string, forUpdate = false): Promise<Return> {
    const ret = await this.returns.findById(q, tenantId, returnId, { forUpdate });
    if (!ret) throw new ReturnNotFoundError(returnId);
    if (ownerId !== undefined) {
      // Una devolución de otro cliente se reporta como inexistente.
      const order = await this.orders.findById(q, tenantId, ret.orderId);
      if (!order || order.userId !== ownerId) throw new ReturnNotFoundError(returnId);
    }
    return ret;
  }

  private async lockOrder(q: Queryable, tenantId: string, orderId: string): Promise<Order> {
    const order = await this.orders.findById(q, tenantId, orderId, { forUpdate: true });
    if (!order) throw new OrderNotFoundError(orderId);
    return order;
  }

  private event(eventType: string, ret: Return, order: OrderProps, actorId: string | null, rejectionReason?: string): DomainEvent {
    const r = ret.toJSON();
    return returnEvent(
      eventType,
      r,
      {
        orderNumber: order.orderNumber!,
        userId: order.userId,
        customerEmail: order.customer.email,
        lines: ret.lineAmounts(order),
        variants: new Map(order.items.map((i) => [i.id, { variantId: i.variantId, sku: i.sku }])),
      },
      { actorId, rejectionReason },
    );
  }

  private detail(ret: Return, order: OrderProps): ReturnDetail {
    const { items, ...header } = ret.toJSON();
    const amounts = ret.lineAmounts(order);
    return {
      ...header,
      order: {
        orderNumber: order.orderNumber!,
        userId: order.userId,
        status: order.status,
        customer: { ...order.customer },
        billing: order.billing,
        paymentMethod: order.paymentMethod,
        fulfillmentType: order.fulfillmentType,
        shippingAddress: order.shippingAddress,
        shippingLocation: order.shippingLocation,
        shippingCity: order.shippingCity,
        sourceWarehouseId: order.sourceWarehouseId,
      },
      lines: items.map((i, n) => {
        const line = order.items.find((o) => o.id === i.orderItemId)!;
        return {
          ...amounts[n],
          returnItemId: i.id,
          variantId: line.variantId,
          productId: line.productId,
          sku: line.sku,
          productName: line.productName,
          colorName: line.colorName,
          sizeCode: line.sizeCode,
          warehouseId: line.warehouseId,
          reasonCode: i.reasonCode,
          condition: i.condition,
          restock: i.restock,
          exchangeVariantId: i.exchangeVariantId,
          photos: i.photos,
        };
      }),
    };
  }
}
