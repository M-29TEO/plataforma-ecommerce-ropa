import { randomUUID } from 'node:crypto';
import { fromCents, ivaCents, toCents } from '../../../shared-kernel';
import { InvalidReturnError, InvalidReturnTransitionError, ReturnNotAllowedError } from './errors';
import type { OrderItem, OrderProps } from './order';

/**
 * Devoluciones y cambios (RMA): sales.returns + sales.return_items.
 *
 *   requested ──▶ approved ──▶ pickup_scheduled ──▶ received ──▶ inspected ──▶ refunded   (devolución)
 *       │            │                                  ▲    │         │   └──▶ exchanged  (cambio de talla)
 *       │            └──── entrega en tienda ───────────┘    │         └──▶ closed     (sin monto a reembolsar)
 *       └──▶ rejected ◀──────────── inspección fallida ──────┘
 *
 * La solicitud la hace el cliente (motivos y fotos), la aprueba el backoffice, Logística retira
 * el paquete (shipment con direction 'return'), bodega lo recibe e inspecciona (condición y si
 * vuelve al stock) y, según el tipo, Pagos reembolsa o Logística despacha la talla nueva.
 */

/** Mismos valores que el CHECK de sales.returns.status. */
export const RETURN_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'pickup_scheduled',
  'received',
  'inspected',
  'refunded',
  'exchanged',
  'closed',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const RETURN_TYPES = ['return', 'exchange'] as const;
export type ReturnType = (typeof RETURN_TYPES)[number];

/** Cómo se devuelve el dinero de una devolución: al medio de pago original o como saldo en gift card. */
export const REFUND_RESOLUTIONS = ['refund_original', 'store_credit'] as const;
export type ReturnResolution = (typeof REFUND_RESOLUTIONS)[number] | 'exchange';

export const RETURN_REASON_CODES = ['size_small', 'size_large', 'defect', 'not_as_described', 'wrong_item', 'changed_mind', 'other'] as const;
export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

export const ITEM_CONDITIONS = ['new', 'used', 'damaged'] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

export const REASON_LABELS: Readonly<Record<ReturnReasonCode, string>> = {
  size_small: 'Talla pequeña',
  size_large: 'Talla grande',
  defect: 'Producto defectuoso',
  not_as_described: 'No corresponde a la descripción',
  wrong_item: 'Producto equivocado',
  changed_mind: 'Cambio de opinión',
  other: 'Otro motivo',
};

/** Motivos imputables a la tienda: exigen al menos una foto y la tienda paga el retiro. */
const STORE_FAULT: ReadonlySet<ReturnReasonCode> = new Set(['defect', 'not_as_described', 'wrong_item']);
export const MAX_PHOTOS_PER_ITEM = 5;
/** Estados en los que las unidades de la solicitud todavía no se registraron como devueltas. */
export const OPEN_RETURN_STATUSES: readonly ReturnStatus[] = ['requested', 'approved', 'pickup_scheduled', 'received'];

const TRANSITIONS: Readonly<Record<ReturnStatus, readonly ReturnStatus[]>> = {
  requested: ['approved', 'rejected'],
  approved: ['pickup_scheduled', 'received'],
  pickup_scheduled: ['received'],
  received: ['inspected', 'rejected'],
  inspected: ['refunded', 'exchanged', 'closed'],
  rejected: [],
  refunded: [],
  exchanged: [],
  closed: [],
};

export interface ReturnItem {
  id: string;
  orderItemId: string;
  quantity: number;
  reasonCode: ReturnReasonCode;
  /** Se conoce en la inspección. */
  condition: ItemCondition | null;
  /** true: la unidad vuelve al stock vendible (movimiento 'return'). */
  restock: boolean | null;
  /** Solo en cambios: la variante (otra talla del mismo producto) que se despacha. */
  exchangeVariantId: string | null;
  /** Claves de las fotos en el almacenamiento de archivos. */
  photos: string[];
}

export interface ReturnProps {
  id: string;
  tenantId: string;
  orderId: string;
  /** RMA-<pedido>-<n>, único por tenant. */
  rmaNumber: string;
  type: ReturnType;
  status: ReturnStatus;
  resolution: ReturnResolution;
  reason: string;
  customerNotes: string | null;
  /** Monto a reembolsar (IVA incluido), calculado en la inspección. null en cambios. */
  refundAmount: string | null;
  returnShippingPaidBy: 'customer' | 'store';
  approvedBy: string | null;
  createdAt: Date;
  closedAt: Date | null;
  items: ReturnItem[];
}

export interface NewReturnItem {
  orderItemId: string;
  quantity: number;
  reasonCode: ReturnReasonCode;
  exchangeVariantId?: string | null;
  photos?: string[];
}

export interface NewReturn {
  tenantId: string;
  orderId: string;
  type: ReturnType;
  /** Solo devoluciones; por defecto refund_original. */
  resolution?: 'refund_original' | 'store_credit';
  /** Texto libre del cliente; si falta, se arma con los motivos de las líneas. */
  reason?: string | null;
  customerNotes?: string | null;
  items: NewReturnItem[];
}

export interface RequestContext {
  order: OrderProps;
  /** Unidades de cada línea del pedido que ya están en otras solicitudes abiertas. */
  openQuantities: ReadonlyMap<string, number>;
  windowDays: number;
  rmaNumber: string;
  /**
   * Falla de la tienda (defecto, no es lo descrito, prenda equivocada) sin foto: solo cuando la registra
   * el personal por el cliente (soporte); la evidencia se toma en la inspección de bodega.
   */
  photosOptional?: boolean;
  now?: Date;
}

export interface ItemInspection {
  returnItemId: string;
  condition: ItemCondition;
  restock: boolean;
}

/**
 * Valor de las unidades devueltas de una línea, con la misma regla que el pedido y la factura:
 * el descuento de la línea se prorratea por unidad (redondeo al centavo) y el IVA se calcula
 * sobre la base resultante. Es lo que se reembolsa y lo que lleva la nota de crédito.
 */
export interface ReturnLineAmount {
  orderItemId: string;
  quantity: number;
  unitPrice: string;
  discount: string;
  taxBase: string;
  taxCode: string;
  taxRate: string;
  taxAmount: string;
  total: string;
}

export function returnLineAmount(item: OrderItem, quantity: number): ReturnLineAmount {
  const discount = Math.round((toCents(item.discount) * quantity) / item.quantity);
  const base = quantity * toCents(item.unitPrice) - discount;
  const tax = ivaCents(base, toCents(item.taxRate));
  return {
    orderItemId: item.id,
    quantity,
    unitPrice: item.unitPrice,
    discount: fromCents(discount),
    taxBase: fromCents(base),
    taxCode: item.taxCode,
    taxRate: item.taxRate,
    taxAmount: fromCents(tax),
    total: fromCents(base + tax),
  };
}

export function isReturnStatus(value: string): value is ReturnStatus {
  return (RETURN_STATUSES as readonly string[]).includes(value);
}

/** Agregado Devolución. Cambia de estado solo con sus métodos, que validan la transición. */
export class Return {
  private constructor(private props: ReturnProps) {}

  static request(input: NewReturn, ctx: RequestContext): Return {
    const now = ctx.now ?? new Date();
    const { order } = ctx;
    if (order.status !== 'delivered' && order.status !== 'partially_returned') {
      throw new ReturnNotAllowedError('ORDER_NOT_RETURNABLE', 'Solo se pueden devolver pedidos entregados', { status: order.status });
    }
    const deadline = order.deliveredAt ? order.deliveredAt.getTime() + ctx.windowDays * 86_400_000 : 0;
    if (now.getTime() > deadline) {
      throw new ReturnNotAllowedError('RETURN_WINDOW_EXPIRED', `El plazo para devolver es de ${ctx.windowDays} días desde la entrega`, {
        deliveredAt: order.deliveredAt?.toISOString() ?? null,
        windowDays: ctx.windowDays,
      });
    }
    if (!(RETURN_TYPES as readonly string[]).includes(input.type)) {
      throw new InvalidReturnError('INVALID_RETURN_TYPE', 'El tipo debe ser return (devolución) o exchange (cambio)');
    }
    if (!input.items?.length) throw new InvalidReturnError('EMPTY_RETURN', 'Indica al menos un producto a devolver');
    const exchange = input.type === 'exchange';
    const resolution: ReturnResolution = exchange ? 'exchange' : (input.resolution ?? 'refund_original');
    if (!exchange && !(REFUND_RESOLUTIONS as readonly string[]).includes(resolution)) {
      throw new InvalidReturnError('INVALID_RESOLUTION', 'El reembolso es al medio de pago original (refund_original) o en gift card (store_credit)');
    }

    const seen = new Set<string>();
    const items = input.items.map((i): ReturnItem => {
      const line = order.items.find((o) => o.id === i.orderItemId);
      if (!line) throw new InvalidReturnError('ORDER_ITEM_NOT_FOUND', 'El producto no pertenece al pedido', { orderItemId: i.orderItemId });
      if (seen.has(line.id)) throw new InvalidReturnError('DUPLICATE_ITEM', 'Cada producto del pedido va una sola vez', { orderItemId: line.id });
      seen.add(line.id);
      if (!Number.isInteger(i.quantity) || i.quantity <= 0) {
        throw new InvalidReturnError('INVALID_QUANTITY', 'La cantidad debe ser un entero positivo', { orderItemId: line.id });
      }
      const available = line.quantity - line.qtyReturned - (ctx.openQuantities.get(line.id) ?? 0);
      if (i.quantity > available) {
        throw new InvalidReturnError('RETURN_QUANTITY_EXCEEDED', 'La cantidad supera las unidades que aún se pueden devolver', {
          orderItemId: line.id,
          requested: i.quantity,
          available: Math.max(0, available),
        });
      }
      if (!(RETURN_REASON_CODES as readonly string[]).includes(i.reasonCode)) {
        throw new InvalidReturnError('INVALID_REASON', 'Motivo de devolución desconocido', { reasonCode: i.reasonCode });
      }
      const photos = [...new Set(i.photos ?? [])];
      if (photos.length > MAX_PHOTOS_PER_ITEM) {
        throw new InvalidReturnError('TOO_MANY_PHOTOS', `Máximo ${MAX_PHOTOS_PER_ITEM} fotos por producto`, { orderItemId: line.id });
      }
      if (STORE_FAULT.has(i.reasonCode) && photos.length === 0 && !ctx.photosOptional) {
        throw new InvalidReturnError('PHOTO_REQUIRED', `Adjunta al menos una foto del producto (${REASON_LABELS[i.reasonCode].toLowerCase()})`, {
          orderItemId: line.id,
        });
      }
      const exchangeVariantId = i.exchangeVariantId ?? null;
      if (exchange && !exchangeVariantId) {
        throw new InvalidReturnError('EXCHANGE_VARIANT_REQUIRED', 'Indica la talla (variante) por la que quieres cambiar', { orderItemId: line.id });
      }
      if (exchange && exchangeVariantId === line.variantId) {
        throw new InvalidReturnError('SAME_VARIANT', 'La variante nueva debe ser distinta de la comprada', { orderItemId: line.id });
      }
      if (!exchange && exchangeVariantId) {
        throw new InvalidReturnError('EXCHANGE_VARIANT_NOT_ALLOWED', 'Una devolución no lleva variante de cambio', { orderItemId: line.id });
      }
      return {
        id: randomUUID(),
        orderItemId: line.id,
        quantity: i.quantity,
        reasonCode: i.reasonCode,
        condition: null,
        restock: null,
        exchangeVariantId,
        photos,
      };
    });

    const reason =
      input.reason?.trim() || [...new Set(items.map((i) => REASON_LABELS[i.reasonCode]))].join(', ');
    return new Return({
      id: randomUUID(),
      tenantId: input.tenantId,
      orderId: order.id,
      rmaNumber: ctx.rmaNumber,
      type: input.type,
      status: 'requested',
      resolution,
      reason: reason.slice(0, 500),
      customerNotes: input.customerNotes?.trim() || null,
      refundAmount: null,
      returnShippingPaidBy: items.some((i) => STORE_FAULT.has(i.reasonCode)) ? 'store' : 'customer',
      approvedBy: null,
      createdAt: now,
      closedAt: null,
      items,
    });
  }

  static restore(props: ReturnProps): Return {
    return new Return({ ...props, items: props.items.map((i) => ({ ...i, photos: [...i.photos] })) });
  }

  get id(): string {
    return this.props.id;
  }
  get status(): ReturnStatus {
    return this.props.status;
  }
  get type(): ReturnType {
    return this.props.type;
  }
  get orderId(): string {
    return this.props.orderId;
  }
  get rmaNumber(): string {
    return this.props.rmaNumber;
  }

  toJSON(): ReturnProps {
    return { ...this.props, items: this.props.items.map((i) => ({ ...i, photos: [...i.photos] })) };
  }

  approve(approverId: string): void {
    this.move('approved');
    this.props.approvedBy = approverId;
  }

  /** Antes de aprobar (solicitud improcedente) o tras recibir (la inspección no la acepta). */
  reject(reason: string, now = new Date()): string {
    const clean = reason?.trim();
    if (!clean) throw new InvalidReturnError('REASON_REQUIRED', 'Indica el motivo del rechazo');
    this.move('rejected');
    this.props.closedAt = now;
    return clean;
  }

  /** Logística creó el retiro. Idempotente. */
  schedulePickup(): boolean {
    if (this.props.status === 'pickup_scheduled') return false;
    this.move('pickup_scheduled');
    return true;
  }

  receive(): void {
    this.move('received');
  }

  /**
   * Bodega inspecciona TODAS las líneas (condición y reingreso al stock). En una devolución fija el
   * monto a reembolsar: el valor pagado de las unidades devueltas; si es 0 la devolución se cierra.
   */
  inspect(inspections: ItemInspection[], order: OrderProps, now = new Date()): ReturnLineAmount[] {
    const byId = new Map(inspections.map((i) => [i.returnItemId, i]));
    if (byId.size !== inspections.length) throw new InvalidReturnError('DUPLICATE_ITEM', 'Cada línea se inspecciona una sola vez');
    for (const id of byId.keys()) {
      if (!this.props.items.some((i) => i.id === id)) {
        throw new InvalidReturnError('RETURN_ITEM_NOT_FOUND', 'La línea no pertenece a la devolución', { returnItemId: id });
      }
    }
    const missing = this.props.items.filter((i) => !byId.has(i.id));
    if (missing.length) {
      throw new InvalidReturnError('INSPECTION_INCOMPLETE', 'Inspecciona todas las líneas de la devolución', {
        missing: missing.map((i) => i.id),
      });
    }
    for (const i of inspections) {
      if (!(ITEM_CONDITIONS as readonly string[]).includes(i.condition)) {
        throw new InvalidReturnError('INVALID_CONDITION', 'La condición debe ser new, used o damaged', { returnItemId: i.returnItemId });
      }
      if (i.restock && i.condition === 'damaged') {
        throw new InvalidReturnError('DAMAGED_NOT_RESTOCKABLE', 'Una unidad dañada no vuelve al stock vendible', { returnItemId: i.returnItemId });
      }
    }
    this.move('inspected');
    for (const item of this.props.items) {
      const i = byId.get(item.id)!;
      item.condition = i.condition;
      item.restock = i.restock;
    }
    const lines = this.lineAmounts(order);
    if (this.props.type === 'return') {
      const total = lines.reduce((s, l) => s + toCents(l.total), 0);
      this.props.refundAmount = fromCents(total);
      if (total === 0) this.close(now);
    }
    return lines;
  }

  /** Valor de cada línea de la devolución, en el orden de sus ítems. */
  lineAmounts(order: OrderProps): ReturnLineAmount[] {
    return this.props.items.map((i) => {
      const line = order.items.find((o) => o.id === i.orderItemId);
      if (!line) throw new Error(`La línea ${i.orderItemId} de la devolución ${this.props.id} no está en el pedido`);
      return returnLineAmount(line, i.quantity);
    });
  }

  /** Pagos confirmó el reembolso. Idempotente. */
  markRefunded(now = new Date()): boolean {
    if (this.props.status === 'refunded') return false;
    if (this.props.type !== 'return') throw new InvalidReturnTransitionError(this.props.status, 'refunded');
    this.move('refunded');
    this.props.closedAt = now;
    return true;
  }

  /** Logística creó el envío con la talla nueva. Idempotente. */
  markExchanged(now = new Date()): boolean {
    if (this.props.status === 'exchanged') return false;
    if (this.props.type !== 'exchange') throw new InvalidReturnTransitionError(this.props.status, 'exchanged');
    this.move('exchanged');
    this.props.closedAt = now;
    return true;
  }

  private close(now: Date): void {
    this.move('closed');
    this.props.closedAt = now;
  }

  private move(to: ReturnStatus): void {
    if (!TRANSITIONS[this.props.status].includes(to)) throw new InvalidReturnTransitionError(this.props.status, to);
    this.props.status = to;
  }
}
