import { ConflictError, PAYMENT_TTL_MAX_MINUTES, toCents, ValidationError } from '../../../shared-kernel';
import type { CartIssue, CartLineView } from '../../cart';
import type { SellableVariant } from '../../catalog';
import type { ReservationLine } from '../../inventory';
import type { NewOrderItem } from '../../orders';

/** Métodos que el cliente elige. 'gift_card' no se elige: se usa cuando la gift card cubre todo. */
export const CHECKOUT_PAYMENT_METHODS = ['card', 'deuna', 'pichincha', 'qr', 'transfer', 'cod'] as const;
export type CheckoutPaymentMethod = (typeof CHECKOUT_PAYMENT_METHODS)[number];

/** Paquete que cotiza Logística: peso real y volumen de las líneas que se compran. */
export interface Parcel {
  weightG: number;
  volumeCm3: number;
}

/**
 * Suma el peso (weight_g) y el volumen (largo × ancho × alto, en mm → cm³) de las líneas
 * facturables. Una variante sin dimensiones no suma volumen (cuenta solo su peso).
 */
export function parcelOf(items: CartLineView[], variants: Map<string, SellableVariant>): Parcel {
  let weightG = 0;
  let volumeMm3 = 0;
  for (const line of items) {
    const v = variants.get(line.variantId);
    if (!line.billable || !v) continue;
    weightG += v.weightG * line.quantity;
    if (v.lengthMm && v.widthMm && v.heightMm) volumeMm3 += v.lengthMm * v.widthMm * v.heightMm * line.quantity;
  }
  return { weightG, volumeCm3: Math.round(volumeMm3 / 1000) };
}

/** Reserva del stock: el pago vence antes, así una captura a último minuto aún encuentra la reserva. */
export const RESERVATION_MARGIN_SECONDS = 10 * 60;
/** Plazo máximo de un pago (72 h, validado en la config) más el margen: la reserva nunca queda más corta que el pago. */
export const RESERVATION_MAX_SECONDS = PAYMENT_TTL_MAX_MINUTES * 60 + RESERVATION_MARGIN_SECONDS;
/** COD y pedidos pagados con gift card: la reserva se confirma en segundos por el relay. */
export const RESERVATION_DEFAULT_SECONDS = 60 * 60;

export function reservationTtlSeconds(paymentTtlSeconds: number | null): number {
  if (paymentTtlSeconds === null) return RESERVATION_DEFAULT_SECONDS;
  return Math.min(paymentTtlSeconds + RESERVATION_MARGIN_SECONDS, RESERVATION_MAX_SECONDS);
}

export class CartNotReadyError extends ConflictError {
  constructor(details: Record<string, unknown>) {
    super('CART_NOT_READY', 'El carrito tiene productos agotados, sin stock suficiente o no disponibles', details);
  }
}

/** El cliente vio otro total (cambió un precio, venció una promoción): debe revisar antes de pagar. */
export class CheckoutTotalChangedError extends ConflictError {
  constructor(expected: string, actual: string) {
    super('CHECKOUT_TOTAL_CHANGED', `El total cambió de $${expected} a $${actual}; revisa el pedido`, { expected, actual });
  }
}

export class InvalidCheckoutError extends ValidationError {}

/** Resumen de los avisos que impiden comprar, por línea. */
export function blockingIssues(items: CartLineView[]): { variantId: string; issues: CartIssue[] }[] {
  return items
    .map((i) => ({ variantId: i.variantId, issues: i.issues.filter((x) => x.code !== 'PRICE_CHANGED') }))
    .filter((i) => i.issues.length > 0);
}

/**
 * Líneas del pedido a partir del carrito ya cotizado: los snapshots, precios, descuentos e IVA
 * salen del carrito (que los tomó de Catálogo y Promociones en esta misma transacción).
 * La bodega de la línea se indica solo si toda la variante sale de una bodega.
 */
export function toOrderItems(
  items: CartLineView[],
  allocation: ReservationLine[],
  unitCosts: Map<string, string | null>,
): NewOrderItem[] {
  return items.map((l) => {
    if (!l.billable || !l.productId || !l.sku || !l.productName || !l.unitPrice || !l.taxCode || !l.taxRate) {
      throw new CartNotReadyError({ variantId: l.variantId });
    }
    const sources = [...new Set(allocation.filter((a) => a.variantId === l.variantId).map((a) => a.warehouseId))];
    return {
      variantId: l.variantId,
      productId: l.productId,
      sku: l.sku,
      productName: l.productName,
      brandName: l.brandName,
      categoryPath: l.categoryPath,
      colorName: l.colorName,
      sizeCode: l.sizeCode,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount ?? '0.00',
      taxCode: l.taxCode,
      taxRate: l.taxRate,
      unitCost: unitCosts.get(l.variantId) ?? null,
      warehouseId: sources.length === 1 ? sources[0] : null,
    };
  });
}

/** Bodega de origen del pedido: la única de la asignación (o null si se reparte entre varias). */
export function sourceWarehouse(allocation: ReservationLine[]): string | null {
  const ids = [...new Set(allocation.map((a) => a.warehouseId))];
  return ids.length === 1 ? ids[0] : null;
}

/** Monto a cubrir con la gift card: su saldo, sin pasar del total. */
export function giftCardAmount(totalCents: number, balance: string): number {
  return Math.max(0, Math.min(totalCents, toCents(balance)));
}
