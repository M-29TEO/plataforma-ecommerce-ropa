import type { OrderDetail, OrderItem } from './commerce-types';
import type { ProductDetail, StockLevel } from './types';

/**
 * Devoluciones y cambios de talla (RMA) del cliente: etiquetas, elegibilidad, cantidades que aún se
 * pueden devolver y armado del cuerpo de POST /me/orders/:orderId/returns. Mismas reglas que el
 * agregado Devolución del backend (orders/domain/return.ts), para avisar antes de enviar; el API
 * sigue siendo quien decide.
 */

export const RETURN_STATUSES = ['requested', 'approved', 'rejected', 'pickup_scheduled', 'received', 'inspected', 'refunded', 'exchanged', 'closed'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export type ReturnType = 'return' | 'exchange';
export type RefundResolution = 'refund_original' | 'store_credit';
export const RETURN_REASON_CODES = ['size_small', 'size_large', 'defect', 'not_as_described', 'wrong_item', 'changed_mind', 'other'] as const;
export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

/** Plazo por defecto del backend (RETURN_WINDOW_DAYS). Si allá se cambia, el API responde RETURN_WINDOW_EXPIRED. */
export const RETURN_WINDOW_DAYS = 30;
export const MAX_PHOTOS_PER_ITEM = 5;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const RETURN_STATUS_LABEL: Record<ReturnStatus, string> = {
  requested: 'Solicitada',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  pickup_scheduled: 'Retiro programado',
  received: 'Recibida en bodega',
  inspected: 'Revisada',
  refunded: 'Reembolsada',
  exchanged: 'Cambio enviado',
  closed: 'Cerrada',
};

/** Qué sigue en cada estado, para el cliente. */
export const RETURN_STATUS_HINT: Record<ReturnStatus, string> = {
  requested: 'Estamos revisando tu solicitud.',
  approved: 'Aprobada: pronto programamos el retiro.',
  rejected: 'No pudimos aceptar la solicitud.',
  pickup_scheduled: 'Un motorizado o courier pasará a retirar el paquete.',
  received: 'Recibimos el paquete y lo estamos revisando.',
  inspected: 'Revisamos el producto; falta el reembolso o el envío de la talla nueva.',
  refunded: 'Reembolsamos el valor al medio elegido.',
  exchanged: 'La talla nueva va en camino.',
  closed: 'La devolución terminó.',
};

export const RETURN_REASON_LABEL: Record<ReturnReasonCode, string> = {
  size_small: 'Me queda pequeño',
  size_large: 'Me queda grande',
  defect: 'Producto defectuoso',
  not_as_described: 'No corresponde a la descripción',
  wrong_item: 'Recibí otro producto',
  changed_mind: 'Cambié de opinión',
  other: 'Otro motivo',
};

export const RETURN_TYPE_LABEL: Record<ReturnType, string> = { return: 'Devolución', exchange: 'Cambio de talla' };

export const RESOLUTION_LABEL: Record<RefundResolution | 'exchange', string> = {
  refund_original: 'Reembolso al medio de pago',
  store_credit: 'Saldo en gift card',
  exchange: 'Cambio de talla',
};

/** Motivos imputables a la tienda: el API exige al menos una foto (PHOTO_REQUIRED) y la tienda paga el retiro. */
export const PHOTO_REQUIRED_REASONS: ReadonlySet<ReturnReasonCode> = new Set(['defect', 'not_as_described', 'wrong_item']);

/** Estados en los que las unidades todavía no constan como devueltas, pero ya están pedidas. */
export const OPEN_RETURN_STATUSES: ReadonlySet<ReturnStatus> = new Set(['requested', 'approved', 'pickup_scheduled', 'received']);

/** Devolución tal como la listan GET /me/returns y POST /me/orders/:id/returns (sin y con líneas detalladas). */
export interface CustomerReturn {
  id: string;
  orderId: string;
  rmaNumber: string;
  type: ReturnType;
  status: ReturnStatus;
  resolution: RefundResolution | 'exchange';
  reason: string;
  customerNotes: string | null;
  /** IVA incluido; se conoce en la inspección. null en cambios. */
  refundAmount: string | null;
  returnShippingPaidBy: 'customer' | 'store';
  createdAt: string;
  closedAt: string | null;
  /** Solo en el listado. */
  items?: Array<{ id: string; orderItemId: string; quantity: number; reasonCode: ReturnReasonCode; exchangeVariantId: string | null }>;
}

/** GET /me/returns/:id (y la respuesta de la solicitud): con el pedido y las líneas con su valor. */
export interface CustomerReturnDetail extends CustomerReturn {
  order: { orderNumber: string; status: string };
  lines: Array<{
    returnItemId: string;
    orderItemId: string;
    variantId: string;
    productId: string;
    productName: string;
    colorName: string | null;
    sizeCode: string | null;
    quantity: number;
    reasonCode: ReturnReasonCode;
    condition: string | null;
    exchangeVariantId: string | null;
    total: string;
    photos: string[];
  }>;
}

/** Fin del plazo para devolver (entrega + N días); null si el pedido no tiene fecha de entrega. */
export function returnDeadline(deliveredAt: string | null, windowDays = RETURN_WINDOW_DAYS): Date | null {
  if (!deliveredAt) return null;
  const t = new Date(deliveredAt).getTime();
  return Number.isFinite(t) ? new Date(t + windowDays * 86_400_000) : null;
}

/** Unidades de cada línea que ya están en solicitudes abiertas (aún no constan en qtyReturned). */
export function openQuantities(returns: readonly CustomerReturn[]): Map<string, number> {
  const open = new Map<string, number>();
  for (const r of returns) {
    if (!OPEN_RETURN_STATUSES.has(r.status)) continue;
    for (const i of r.items ?? []) open.set(i.orderItemId, (open.get(i.orderItemId) ?? 0) + i.quantity);
  }
  return open;
}

/** Máximo devolvible por línea: comprada − ya devuelta − en otras solicitudes abiertas. */
export function returnableQuantity(item: Pick<OrderItem, 'id' | 'quantity' | 'qtyReturned'>, open: ReadonlyMap<string, number>): number {
  return Math.max(0, item.quantity - (item.qtyReturned ?? 0) - (open.get(item.id) ?? 0));
}

/**
 * ¿Se muestra "Solicitar devolución o cambio"? Pedido entregado (o devuelto en parte), dentro del
 * plazo y con alguna unidad que aún se pueda devolver.
 */
export function canRequestReturn(
  order: Pick<OrderDetail, 'status' | 'deliveredAt' | 'items'>,
  returns: readonly CustomerReturn[],
  now: Date = new Date(),
): boolean {
  if (order.status !== 'delivered' && order.status !== 'partially_returned') return false;
  const deadline = returnDeadline(order.deliveredAt);
  if (!deadline || now.getTime() > deadline.getTime()) return false;
  const open = openQuantities(returns);
  return order.items.some((i) => returnableQuantity(i, open) > 0);
}

/** Días que quedan para devolver (0 el último día); null si ya venció o no hay entrega. */
export function daysLeftToReturn(deliveredAt: string | null, now: Date = new Date()): number | null {
  const deadline = returnDeadline(deliveredAt);
  if (!deadline) return null;
  const ms = deadline.getTime() - now.getTime();
  return ms < 0 ? null : Math.floor(ms / 86_400_000);
}

export interface SizeOption {
  variantId: string;
  size: string;
  stock: StockLevel;
}

/** Tallas para el cambio: otras tallas del mismo color con stock (el API exige mismo producto, vendible y con stock). */
export function exchangeSizeOptions(product: Pick<ProductDetail, 'variants'>, item: Pick<OrderItem, 'variantId' | 'colorName'>): SizeOption[] {
  return product.variants
    .filter((v) => v.id !== item.variantId && v.size && v.stock !== 'out_of_stock' && (v.color?.name ?? null) === (item.colorName ?? null))
    .map((v) => ({ variantId: v.id, size: v.size!, stock: v.stock }));
}

/** null si la foto sirve; si no, el motivo (mismas reglas que POST /me/returns/photos). */
export function photoFileError(file: { type: string; size: number }): string | null {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) return 'La foto debe ser JPG, PNG o WEBP.';
  if (file.size > PHOTO_MAX_BYTES) return 'La foto supera 5 MB.';
  if (file.size === 0) return 'El archivo está vacío.';
  return null;
}

// ------------------------------------------------------------------ formulario

export interface ReturnLineDraft {
  orderItemId: string;
  selected: boolean;
  quantity: number;
  reasonCode: ReturnReasonCode | '';
  exchangeVariantId: string;
  /** Claves devueltas por POST /me/returns/photos. */
  photos: string[];
}

export interface ReturnDraft {
  type: ReturnType;
  resolution: RefundResolution;
  customerNotes: string;
  lines: ReturnLineDraft[];
}

export function emptyReturnDraft(items: readonly Pick<OrderItem, 'id'>[]): ReturnDraft {
  return {
    type: 'return',
    resolution: 'refund_original',
    customerNotes: '',
    lines: items.map((i) => ({ orderItemId: i.id, selected: false, quantity: 1, reasonCode: '', exchangeVariantId: '', photos: [] })),
  };
}

export type LineField = 'quantity' | 'reasonCode' | 'exchangeVariantId' | 'photos';

export interface DraftErrors {
  /** Error general (p. ej. ningún producto elegido). */
  form?: string;
  lines: Record<string, Partial<Record<LineField, string>>>;
}

/** Valida lo que se puede saber sin el API. `available`: máximo devolvible por línea. */
export function validateReturnDraft(draft: ReturnDraft, available: ReadonlyMap<string, number>): DraftErrors {
  const errors: DraftErrors = { lines: {} };
  const chosen = draft.lines.filter((l) => l.selected);
  if (chosen.length === 0) errors.form = 'Elige al menos un producto.';
  for (const l of chosen) {
    const e: Partial<Record<LineField, string>> = {};
    const max = available.get(l.orderItemId) ?? 0;
    if (!Number.isInteger(l.quantity) || l.quantity < 1) e.quantity = 'La cantidad debe ser al menos 1.';
    else if (l.quantity > max) e.quantity = max === 0 ? 'Ya no quedan unidades por devolver.' : `Puedes devolver hasta ${max}.`;
    if (!l.reasonCode) e.reasonCode = 'Elige el motivo.';
    else if (PHOTO_REQUIRED_REASONS.has(l.reasonCode) && l.photos.length === 0) e.photos = 'Para este motivo adjunta al menos una foto.';
    if (l.photos.length > MAX_PHOTOS_PER_ITEM) e.photos = `Máximo ${MAX_PHOTOS_PER_ITEM} fotos por producto.`;
    if (draft.type === 'exchange' && !l.exchangeVariantId) e.exchangeVariantId = 'Elige la talla nueva.';
    if (Object.keys(e).length) errors.lines[l.orderItemId] = e;
  }
  return errors;
}

export function hasErrors(errors: DraftErrors): boolean {
  return !!errors.form || Object.keys(errors.lines).length > 0;
}

export interface CreateReturnBody {
  type: ReturnType;
  resolution?: RefundResolution;
  customerNotes?: string;
  items: Array<{ orderItemId: string; quantity: number; reasonCode: ReturnReasonCode; exchangeVariantId?: string; photos?: string[] }>;
}

/**
 * Cuerpo de POST /me/orders/:orderId/returns. El API rechaza campos extra: la resolución solo va en
 * devoluciones y la variante de cambio solo en cambios. El motivo general lo arma el backend con
 * los de cada línea.
 */
export function buildReturnBody(draft: ReturnDraft): CreateReturnBody {
  const exchange = draft.type === 'exchange';
  const notes = draft.customerNotes.trim().slice(0, 1000);
  return {
    type: draft.type,
    ...(exchange ? {} : { resolution: draft.resolution }),
    ...(notes ? { customerNotes: notes } : {}),
    items: draft.lines
      .filter((l) => l.selected)
      .map((l) => ({
        orderItemId: l.orderItemId,
        quantity: l.quantity,
        reasonCode: l.reasonCode as ReturnReasonCode,
        ...(exchange && l.exchangeVariantId ? { exchangeVariantId: l.exchangeVariantId } : {}),
        ...(l.photos.length ? { photos: l.photos.slice(0, MAX_PHOTOS_PER_ITEM) } : {}),
      })),
  };
}

/** Errores del API que señalan una línea (details.orderItemId): se muestran junto a ella. */
const LINE_ERROR_FIELD: Record<string, LineField> = {
  RETURN_QUANTITY_EXCEEDED: 'quantity',
  INVALID_QUANTITY: 'quantity',
  PHOTO_REQUIRED: 'photos',
  TOO_MANY_PHOTOS: 'photos',
  INVALID_PHOTO: 'photos',
  EXCHANGE_VARIANT_REQUIRED: 'exchangeVariantId',
  EXCHANGE_VARIANT_INVALID: 'exchangeVariantId',
  SAME_VARIANT: 'exchangeVariantId',
  INVALID_REASON: 'reasonCode',
};

/** Ubica un error del API en su línea y campo; si no aplica, devuelve null y va como error general. */
export function lineErrorFromApi(code: string, details: Record<string, unknown>): { orderItemId: string; field: LineField } | null {
  const field = LINE_ERROR_FIELD[code];
  const orderItemId = typeof details.orderItemId === 'string' ? details.orderItemId : null;
  return field && orderItemId ? { orderItemId, field } : null;
}

/** Mensaje en español para los códigos que el cliente puede encontrarse al enviar. */
export function returnApiMessage(code: string, fallback: string): string {
  if (code === 'RETURN_WINDOW_EXPIRED') return 'El plazo para devolver este pedido ya venció.';
  if (code === 'ORDER_NOT_RETURNABLE') return 'Solo se pueden devolver pedidos entregados.';
  if (code === 'EXCHANGE_OUT_OF_STOCK') return 'Ya no hay stock de la talla elegida. Elige otra o pide una devolución.';
  if (code === 'EXCHANGE_VARIANT_INVALID') return 'Esa talla ya no está disponible para el cambio.';
  return fallback;
}
