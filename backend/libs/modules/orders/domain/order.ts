import { randomUUID } from 'node:crypto';
import { DomainEvent, fromCents, toCents } from '../../../shared-kernel';
import { CustomerCannotTransitionError, InvalidOrderError, ReasonRequiredError } from './errors';
import { orderCancelled, orderDelivered, orderPaid } from './events';
import {
  assertTransition,
  FULFILLMENT_TYPES,
  FulfillmentType,
  OrderStatus,
  PAYMENT_METHODS,
  PaymentMethod,
  REASON_REQUIRED,
} from './order-status';

export type PaymentStatus = 'pending' | 'authorized' | 'paid' | 'cod_pending' | 'partially_refunded' | 'refunded' | 'failed';
export type OrderChannel = 'web' | 'app' | 'whatsapp' | 'backoffice' | 'store';
export type ActorType = 'customer' | 'staff' | 'rider' | 'system' | 'courier';

export interface Actor {
  type: ActorType;
  id: string | null;
}

export interface CustomerSnapshot {
  name: string;
  email: string;
  phone?: string;
  idType?: string;
  idNumber?: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * Línea del pedido. Todo lo descriptivo (nombre, marca, color, talla, precio, IVA) es un
 * SNAPSHOT del momento de la compra: si el catálogo cambia después, el pedido no cambia.
 * Los montos son numeric(12,2) como string ("19.90").
 */
export interface OrderItem {
  id: string;
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  brandName: string | null;
  categoryPath: string | null;
  colorName: string | null;
  sizeCode: string | null;
  quantity: number;
  unitPrice: string;
  discount: string;
  taxCode: string;
  /** Porcentaje, numeric(5,2): "15.00". */
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
  unitCost: string | null;
  warehouseId: string | null;
  qtyReturned: number;
}

export interface OrderProps {
  id: string;
  tenantId: string;
  /** bigint secuencial asignado por PostgreSQL al insertar (null antes de persistir). */
  orderNumber: string | null;
  userId: string | null;
  cartId: string | null;
  customer: CustomerSnapshot;
  billing: Record<string, unknown>;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  fulfillmentType: FulfillmentType;
  shippingAddress: Record<string, unknown> | null;
  shippingLocation: GeoPoint | null;
  shippingCity: string | null;
  shippingZoneId: string | null;
  deliverySlotId: string | null;
  sourceWarehouseId: string | null;
  currency: string;
  subtotal: string;
  discountTotal: string;
  shippingTotal: string;
  taxTotal: string;
  giftCardTotal: string;
  total: string;
  costTotal: string | null;
  channel: OrderChannel;
  sellerId: string | null;
  notes: string | null;
  cancelReason: string | null;
  placedAt: Date;
  paidAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  version: number;
  updatedAt: Date;
  items: OrderItem[];
}

export interface NewOrderItem {
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  brandName?: string | null;
  categoryPath?: string | null;
  colorName?: string | null;
  sizeCode?: string | null;
  quantity: number;
  unitPrice: string | number;
  /** Descuento total de la línea (no por unidad). Los descuentos de pedido se prorratean en Checkout. */
  discount?: string | number;
  taxCode: string;
  taxRate: string | number;
  unitCost?: string | number | null;
  warehouseId?: string | null;
}

export interface NewOrder {
  /** Lo genera Checkout: las reservas de Inventario ya usan este id (idempotencia por PK). */
  id?: string;
  tenantId: string;
  userId?: string | null;
  cartId?: string | null;
  customer: CustomerSnapshot;
  billing: Record<string, unknown>;
  paymentMethod: PaymentMethod;
  fulfillmentType: FulfillmentType;
  shippingAddress?: Record<string, unknown> | null;
  shippingLocation?: GeoPoint | null;
  shippingCity?: string | null;
  shippingZoneId?: string | null;
  deliverySlotId?: string | null;
  sourceWarehouseId?: string | null;
  shippingTotal?: string | number;
  giftCardTotal?: string | number;
  channel?: OrderChannel;
  sellerId?: string | null;
  notes?: string | null;
  items: NewOrderItem[];
}

/** Fila de sales.order_status_history que produce cada cambio de estado. */
export interface StatusChange {
  orderId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorType: ActorType;
  actorId: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface TransitionResult {
  change: StatusChange;
  events: DomainEvent[];
}

const TAX_CODE_RE = /^\d{1,4}$/;
const MAX_RATE_BP = 100_00; // 100.00 %

/**
 * Agregado Pedido. Solo cambia de estado mediante transitionTo(), que consulta la máquina
 * de estados (order-status.ts) y devuelve la fila de historial y los eventos de dominio
 * que el caso de uso debe persistir en la misma transacción.
 */
export class Order {
  private constructor(private props: OrderProps) {}

  static place(input: NewOrder, now = new Date()): Order {
    if (!(PAYMENT_METHODS as readonly string[]).includes(input.paymentMethod)) {
      throw new InvalidOrderError('INVALID_PAYMENT_METHOD', 'Método de pago no soportado', { paymentMethod: input.paymentMethod });
    }
    if (!(FULFILLMENT_TYPES as readonly string[]).includes(input.fulfillmentType)) {
      throw new InvalidOrderError('INVALID_FULFILLMENT_TYPE', 'Tipo de entrega no soportado', {
        fulfillmentType: input.fulfillmentType,
      });
    }
    if (!input.customer?.name?.trim() || !input.customer?.email?.trim()) {
      throw new InvalidOrderError('INVALID_CUSTOMER', 'El pedido requiere nombre y email del cliente');
    }
    if (input.fulfillmentType === 'pickup') {
      if (!input.sourceWarehouseId) {
        throw new InvalidOrderError('PICKUP_WAREHOUSE_REQUIRED', 'El retiro en tienda requiere la tienda de retiro');
      }
    } else if (!input.shippingAddress) {
      throw new InvalidOrderError('SHIPPING_ADDRESS_REQUIRED', 'El envío requiere dirección de entrega');
    }
    if (!input.items?.length) throw new InvalidOrderError('EMPTY_ORDER', 'El pedido no tiene ítems');

    const items = input.items.map((i) => Order.buildItem(i));
    const subtotal = items.reduce((s, i) => s + i.quantity * toCents(i.unitPrice), 0);
    const discountTotal = items.reduce((s, i) => s + toCents(i.discount), 0);
    const taxTotal = items.reduce((s, i) => s + toCents(i.taxAmount), 0);
    const shippingTotal = toCents(input.shippingTotal ?? 0);
    const giftCardTotal = toCents(input.giftCardTotal ?? 0);
    const beforeGiftCard = subtotal - discountTotal + taxTotal + shippingTotal;
    if (giftCardTotal > beforeGiftCard) {
      throw new InvalidOrderError('GIFT_CARD_EXCEEDS_TOTAL', 'La gift card supera el total del pedido');
    }
    const costTotal = items.every((i) => i.unitCost !== null)
      ? fromCents(items.reduce((s, i) => s + i.quantity * toCents(i.unitCost!), 0))
      : null;

    return new Order({
      id: input.id ?? randomUUID(),
      tenantId: input.tenantId,
      orderNumber: null,
      userId: input.userId ?? null,
      cartId: input.cartId ?? null,
      customer: { ...input.customer, name: input.customer.name.trim(), email: input.customer.email.trim().toLowerCase() },
      billing: input.billing,
      status: 'created',
      paymentStatus: input.paymentMethod === 'cod' ? 'cod_pending' : 'pending',
      paymentMethod: input.paymentMethod,
      fulfillmentType: input.fulfillmentType,
      shippingAddress: input.shippingAddress ?? null,
      shippingLocation: input.shippingLocation ?? null,
      shippingCity: input.shippingCity ?? null,
      shippingZoneId: input.shippingZoneId ?? null,
      deliverySlotId: input.deliverySlotId ?? null,
      sourceWarehouseId: input.sourceWarehouseId ?? null,
      currency: 'USD',
      subtotal: fromCents(subtotal),
      discountTotal: fromCents(discountTotal),
      shippingTotal: fromCents(shippingTotal),
      taxTotal: fromCents(taxTotal),
      giftCardTotal: fromCents(giftCardTotal),
      total: fromCents(beforeGiftCard - giftCardTotal),
      costTotal,
      channel: input.channel ?? 'web',
      sellerId: input.sellerId ?? null,
      notes: input.notes?.trim() || null,
      cancelReason: null,
      placedAt: now,
      paidAt: null,
      shippedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      version: 0,
      updatedAt: now,
      items,
    });
  }

  /**
   * IVA por línea sobre (cantidad × precio − descuento), redondeado al centavo (mitad hacia
   * arriba), igual que lo hará la factura electrónica. line_total incluye el IVA.
   */
  private static buildItem(i: NewOrderItem): OrderItem {
    if (!Number.isInteger(i.quantity) || i.quantity <= 0) {
      throw new InvalidOrderError('INVALID_QUANTITY', 'La cantidad debe ser un entero positivo', { variantId: i.variantId });
    }
    if (!i.sku?.trim() || !i.productName?.trim()) {
      throw new InvalidOrderError('INVALID_ITEM_SNAPSHOT', 'Cada ítem requiere SKU y nombre del producto', {
        variantId: i.variantId,
      });
    }
    if (!TAX_CODE_RE.test(i.taxCode)) {
      throw new InvalidOrderError('INVALID_TAX_CODE', 'Código de IVA inválido', { variantId: i.variantId });
    }
    const rateBp = toCents(i.taxRate); // 15.00 % → 1500 puntos básicos
    if (rateBp > MAX_RATE_BP) throw new InvalidOrderError('INVALID_TAX_RATE', 'La tasa de IVA no puede superar 100 %');

    const gross = i.quantity * toCents(i.unitPrice);
    const discount = toCents(i.discount ?? 0);
    if (discount > gross) {
      throw new InvalidOrderError('DISCOUNT_EXCEEDS_LINE', 'El descuento supera el valor de la línea', { variantId: i.variantId });
    }
    const base = gross - discount;
    const tax = Math.round((base * rateBp) / 10_000);

    return {
      id: randomUUID(),
      variantId: i.variantId,
      productId: i.productId,
      sku: i.sku.trim(),
      productName: i.productName.trim(),
      brandName: i.brandName ?? null,
      categoryPath: i.categoryPath ?? null,
      colorName: i.colorName ?? null,
      sizeCode: i.sizeCode ?? null,
      quantity: i.quantity,
      unitPrice: fromCents(toCents(i.unitPrice)),
      discount: fromCents(discount),
      taxCode: i.taxCode,
      taxRate: fromCents(rateBp),
      taxAmount: fromCents(tax),
      lineTotal: fromCents(base + tax),
      unitCost: i.unitCost === undefined || i.unitCost === null ? null : fromCents(toCents(i.unitCost)),
      warehouseId: i.warehouseId ?? null,
      qtyReturned: 0,
    };
  }

  static restore(props: OrderProps): Order {
    return new Order({ ...props, items: props.items.map((i) => ({ ...i })) });
  }

  get id(): string {
    return this.props.id;
  }
  get tenantId(): string {
    return this.props.tenantId;
  }
  get userId(): string | null {
    return this.props.userId;
  }
  get status(): OrderStatus {
    return this.props.status;
  }
  get paymentStatus(): PaymentStatus {
    return this.props.paymentStatus;
  }
  get version(): number {
    return this.props.version;
  }

  toJSON(): OrderProps {
    return {
      ...this.props,
      customer: { ...this.props.customer },
      items: this.props.items.map((i) => ({ ...i })),
    };
  }

  /** Lo llama el repositorio al insertar (la secuencia es de PostgreSQL). */
  assignNumber(orderNumber: string): void {
    this.props.orderNumber = orderNumber;
  }

  /** Lo llama el repositorio tras un UPDATE exitoso (version = version + 1). */
  markPersisted(version: number, updatedAt: Date): void {
    this.props.version = version;
    this.props.updatedAt = updatedAt;
  }

  /**
   * El pago en línea o la transferencia falló o venció: payment_status pasa a failed (antes de
   * cancelar el pedido, así OrderCancelled lo informa). No aplica a contra entrega ni a pagados.
   */
  recordPaymentFailure(now = new Date()): void {
    if (this.props.status !== 'created' || this.props.paymentStatus !== 'pending') return;
    this.props.paymentStatus = 'failed';
    this.props.updatedAt = now;
  }

  /**
   * Devolución aceptada en la inspección: suma las unidades a qty_returned y deja el pedido en
   * partially_returned o returned (si ya se devolvió todo). Devuelve la transición a persistir, o
   * null si el estado no cambia (otra devolución parcial sobre un pedido ya parcialmente devuelto).
   */
  applyReturn(lines: { orderItemId: string; quantity: number }[], rmaNumber: string, actor: Actor, now = new Date()): TransitionResult | null {
    for (const l of lines) {
      const item = this.props.items.find((i) => i.id === l.orderItemId);
      if (!item) throw new InvalidOrderError('ORDER_ITEM_NOT_FOUND', 'La línea devuelta no pertenece al pedido', { orderItemId: l.orderItemId });
      if (!Number.isInteger(l.quantity) || l.quantity <= 0 || item.qtyReturned + l.quantity > item.quantity) {
        throw new InvalidOrderError('RETURN_QUANTITY_EXCEEDED', 'Se devolverían más unidades de las compradas', { orderItemId: item.id });
      }
    }
    for (const l of lines) this.props.items.find((i) => i.id === l.orderItemId)!.qtyReturned += l.quantity;
    this.props.updatedAt = now;
    const target: OrderStatus = this.props.items.every((i) => i.qtyReturned === i.quantity) ? 'returned' : 'partially_returned';
    if (target === this.props.status) return null;
    return this.transitionTo(target, actor, `Devolución ${rmaNumber}`, now);
  }

  /**
   * Pagos confirmó un reembolso. refundedTotal = todo lo reembolsado del pedido hasta ahora. El
   * pedido queda refunded cuando se devolvió el valor de toda la mercadería (el envío no se
   * reembolsa); si no, partially_refunded.
   */
  recordRefund(refundedTotal: string, now = new Date()): boolean {
    const p = this.props;
    const merchandise = toCents(p.total) + toCents(p.giftCardTotal) - toCents(p.shippingTotal);
    const next: PaymentStatus = toCents(refundedTotal) >= merchandise ? 'refunded' : 'partially_refunded';
    if (next === p.paymentStatus) return false;
    p.paymentStatus = next;
    p.updatedAt = now;
    return true;
  }

  /** Fila de historial de la creación (null → created). */
  placedChange(actor: Actor): StatusChange {
    return {
      orderId: this.props.id,
      fromStatus: null,
      toStatus: 'created',
      actorType: actor.type,
      actorId: actor.id,
      reason: null,
      createdAt: this.props.placedAt,
    };
  }

  /**
   * Único punto de cambio de estado. Valida la transición, aplica sus efectos (timestamps,
   * payment_status, motivo) y devuelve el historial y los eventos a persistir.
   */
  transitionTo(to: OrderStatus, actor: Actor, reason?: string | null, now = new Date()): TransitionResult {
    const from = this.props.status;
    assertTransition(from, to, { paymentMethod: this.props.paymentMethod, fulfillmentType: this.props.fulfillmentType });

    if (actor.type === 'customer' && !(to === 'cancelled' && (from === 'created' || from === 'paid'))) {
      throw new CustomerCannotTransitionError(from, to);
    }
    const cleanReason = reason?.trim() || null;
    if (REASON_REQUIRED.has(to) && !cleanReason) throw new ReasonRequiredError(to);

    const p = this.props;
    const events: DomainEvent[] = [];
    p.status = to;
    p.updatedAt = now;

    switch (to) {
      case 'paid':
        p.paymentStatus = 'paid';
        p.paidAt = now;
        events.push(orderPaid(this.toJSON()));
        break;
      case 'shipped':
        p.shippedAt = now;
        break;
      case 'delivered':
        p.deliveredAt = now;
        // Contra entrega: el cobro ocurre al entregar. OrderPaid es el único disparador de
        // Facturación, así que se emite también aquí.
        if (p.paymentMethod === 'cod') {
          p.paymentStatus = 'paid';
          p.paidAt = now;
          events.push(orderPaid(this.toJSON()));
        }
        events.push(orderDelivered(this.toJSON()));
        break;
      case 'cancelled':
        p.cancelledAt = now;
        p.cancelReason = cleanReason;
        events.push(orderCancelled(this.toJSON(), from, cleanReason!, actor.type));
        break;
    }

    return {
      change: { orderId: p.id, fromStatus: from, toStatus: to, actorType: actor.type, actorId: actor.id, reason: cleanReason, createdAt: now },
      events,
    };
  }
}
