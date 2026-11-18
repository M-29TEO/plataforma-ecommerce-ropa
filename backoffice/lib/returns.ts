import type { Tone } from '@/components/ui/Badge';
import type { OrderItem, OrderStatus } from './orders';

/**
 * Devoluciones y cambios (RMA): tipos de /v1/returns (orquestador de posventa) y helpers puros
 * (etiquetas, acciones según estado y permisos, cantidades devolvibles y armado de los cuerpos).
 * Contrato: backend/libs/modules/aftersales y el agregado Devolución de backend/libs/modules/orders
 * (domain/return.ts). El backend vuelve a validar todo: esto solo evita botones que terminarían en
 * 403/409/422.
 */

// ---------------------------------------------------------------- Valores del dominio
export const RETURN_STATUSES = [
  'requested',
  'approved',
  'pickup_scheduled',
  'received',
  'inspected',
  'refunded',
  'exchanged',
  'rejected',
  'closed',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const RETURN_TYPES = ['return', 'exchange'] as const;
export type ReturnType = (typeof RETURN_TYPES)[number];

export const REFUND_RESOLUTIONS = ['refund_original', 'store_credit'] as const;
export type RefundResolution = (typeof REFUND_RESOLUTIONS)[number];
export type ReturnResolution = RefundResolution | 'exchange';

export const RETURN_REASON_CODES = ['size_small', 'size_large', 'defect', 'not_as_described', 'wrong_item', 'changed_mind', 'other'] as const;
export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

export const ITEM_CONDITIONS = ['new', 'used', 'damaged'] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

/** Motivos imputables a la tienda: la tienda paga el retiro; el cliente debe adjuntar foto, soporte no (se verifica en bodega). */
export const PHOTO_REQUIRED_REASONS: ReadonlySet<ReturnReasonCode> = new Set<ReturnReasonCode>(['defect', 'not_as_described', 'wrong_item']);

/** Estados en que las unidades aún no figuran como devueltas en el pedido (OPEN_RETURN_STATUSES). */
export const OPEN_RETURN_STATUSES: readonly ReturnStatus[] = ['requested', 'approved', 'pickup_scheduled', 'received'];

/** Estados en que la devolución todavía requiere trabajo del personal (filtro "Abiertas"). */
export const ACTIVE_RETURN_STATUSES: readonly ReturnStatus[] = ['requested', 'approved', 'pickup_scheduled', 'received', 'inspected'];

/** Pedidos sobre los que se puede registrar una devolución (Return.request). */
const RETURNABLE_ORDER_STATUSES: readonly OrderStatus[] = ['delivered', 'partially_returned'];

/** Tope de líneas por solicitud (ArrayMaxSize del DTO) y de texto. */
export const REASON_MAX = 500;
export const NOTES_MAX = 1000;
export const REJECT_REASON_MIN = 3;

// ---------------------------------------------------------------- Etiquetas
export const RETURN_STATUS: Record<ReturnStatus, [string, Tone]> = {
  requested: ['Solicitada', 'accent'],
  approved: ['Aprobada', 'info'],
  pickup_scheduled: ['Retiro programado', 'info'],
  received: ['Recibida en bodega', 'warn'],
  inspected: ['Inspeccionada', 'warn'],
  refunded: ['Reembolsada', 'ok'],
  exchanged: ['Cambiada', 'ok'],
  rejected: ['Rechazada', 'danger'],
  closed: ['Cerrada', 'neutral'],
};

export const RETURN_TYPE_LABEL: Record<ReturnType, string> = {
  return: 'Devolución',
  exchange: 'Cambio de talla',
};

export const RESOLUTION_LABEL: Record<ReturnResolution, string> = {
  refund_original: 'Reembolso al medio de pago',
  store_credit: 'Saldo en gift card',
  exchange: 'Cambio por otra talla',
};

/** Mismas etiquetas que REASON_LABELS del dominio. */
export const REASON_LABEL: Record<ReturnReasonCode, string> = {
  size_small: 'Talla pequeña',
  size_large: 'Talla grande',
  defect: 'Producto defectuoso',
  not_as_described: 'No corresponde a la descripción',
  wrong_item: 'Producto equivocado',
  changed_mind: 'Cambio de opinión',
  other: 'Otro motivo',
};

export const CONDITION_LABEL: Record<ItemCondition, string> = {
  new: 'Nuevo (con etiquetas)',
  used: 'Usado',
  damaged: 'Dañado',
};

export const SHIPPING_PAID_BY_LABEL: Record<'customer' | 'store', string> = {
  customer: 'Cliente',
  store: 'Tienda',
};

// ---------------------------------------------------------------- Reembolso (Pagos)
export type RefundStatus = 'pending' | 'processing' | 'succeeded' | 'failed';
export type RefundMethod = 'original' | 'transfer' | 'store_credit' | 'gift_card';
export type RefundPart = 'external' | 'gift_cards' | 'store_credit';

export const REFUND_STATUS: Record<RefundStatus, [string, Tone]> = {
  pending: ['Por aprobar', 'warn'],
  processing: ['En proceso', 'info'],
  succeeded: ['Reembolsado', 'ok'],
  failed: ['Fallido', 'danger'],
};

export const REFUND_METHOD_LABEL: Record<RefundMethod, string> = {
  original: 'Medio de pago original',
  transfer: 'Transferencia bancaria',
  store_credit: 'Saldo a favor',
  gift_card: 'Gift card nueva (saldo a favor)',
};

export const REFUND_PART_LABEL: Record<RefundPart, string> = {
  external: 'Pasarela / transferencia',
  gift_cards: 'Gift cards del pedido',
  store_credit: 'Gift card de saldo a favor',
};

/** RefundView de backend/libs/modules/payments (incluido en GET /returns/:id como `refund`). */
export interface Refund {
  id: string;
  paymentId: string;
  orderId: string;
  returnId: string | null;
  amount: string;
  method: RefundMethod;
  status: RefundStatus;
  providerRef: string | null;
  reason: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  createdAt: string;
  completedAt: string | null;
  approvals: { userId: string; at: string }[];
  plan: { external: { kind: 'gateway' | 'transfer'; amount: string } | null; giftCards: string; storeCredit: string } | null;
  completedParts: { part: RefundPart; reference: string; at: string }[];
  failureReason: string | null;
  paymentMethod: string;
  /** 2 por encima de REFUND_DUAL_APPROVAL_ABOVE ($100), si no 1. */
  requiredApprovals: number;
  pendingParts: RefundPart[];
}

// ---------------------------------------------------------------- Comprobantes (Facturación)
export const DOCUMENT_STATUS: Record<string, [string, Tone]> = {
  pending: ['Pendiente', 'neutral'],
  signed: ['Firmado', 'info'],
  sent: ['Enviado al SRI', 'info'],
  received: ['Recibido por el SRI', 'info'],
  authorized: ['Autorizado', 'ok'],
  returned: ['Devuelto por el SRI', 'danger'],
  not_authorized: ['No autorizado', 'danger'],
  voided: ['Anulado', 'neutral'],
};

/** Lo que se usa de DocumentView (GET /billing/documents). docType '01' factura, '04' nota de crédito. */
export interface ElectronicDocument {
  id: string;
  docType: string;
  number: string;
  accessKey: string;
  issueDate: string;
  orderId: string | null;
  returnId: string | null;
  status: string;
  totals: { total: string };
  authorizationNumber: string | null;
  authorizedAt: string | null;
  files: { xml: boolean; ride: boolean };
  createdAt: string;
}

/** Nota de crédito de la devolución (la más reciente si hubiera reintentos). */
export function creditNoteFor(docs: readonly ElectronicDocument[], returnId: string): ElectronicDocument | null {
  const list = docs.filter((d) => d.docType === '04' && d.returnId === returnId);
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return list[0] ?? null;
}

// ---------------------------------------------------------------- Respuestas del API
export interface ReturnItem {
  id: string;
  orderItemId: string;
  quantity: number;
  reasonCode: ReturnReasonCode;
  condition: ItemCondition | null;
  restock: boolean | null;
  exchangeVariantId: string | null;
  photos: string[];
}

/** Fila de GET /returns (ReturnProps). */
export interface ReturnSummary {
  id: string;
  tenantId: string;
  orderId: string;
  rmaNumber: string;
  type: ReturnType;
  status: ReturnStatus;
  resolution: ReturnResolution;
  reason: string;
  customerNotes: string | null;
  /** IVA incluido; se calcula en la inspección (null en cambios y antes de inspeccionar). */
  refundAmount: string | null;
  returnShippingPaidBy: 'customer' | 'store';
  approvedBy: string | null;
  createdAt: string;
  closedAt: string | null;
  items: ReturnItem[];
}

/** Línea de la devolución con el snapshot del producto y su valor (ReturnLineView). */
export interface ReturnLine {
  returnItemId: string;
  orderItemId: string;
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  colorName: string | null;
  sizeCode: string | null;
  warehouseId: string | null;
  quantity: number;
  unitPrice: string;
  discount: string;
  taxBase: string;
  taxCode: string;
  taxRate: string;
  taxAmount: string;
  total: string;
  reasonCode: ReturnReasonCode;
  condition: ItemCondition | null;
  restock: boolean | null;
  exchangeVariantId: string | null;
  photos: string[];
}

/** Envío de logística inversa (ShipmentSummary). */
export interface ReturnShipment {
  id: string;
  orderId: string;
  returnId: string | null;
  direction: string;
  carrierType: string;
  status: string;
  originWarehouseId: string | null;
  priceCharged: string;
  trackingToken: string;
  deliveredAt: string | null;
}

/** GET /returns/:id (ReturnOverview): devolución con pedido, líneas, retiro, envío de cambio y reembolso. */
export interface ReturnDetail extends Omit<ReturnSummary, 'items'> {
  order: {
    orderNumber: string;
    userId: string | null;
    status: OrderStatus;
    customer: { name: string; email: string; phone?: string };
    paymentMethod: string;
    fulfillmentType: string;
    shippingCity: string | null;
    sourceWarehouseId: string | null;
  };
  lines: ReturnLine[];
  pickupShipment: ReturnShipment | null;
  exchangeShipment: ReturnShipment | null;
  refund: Refund | null;
}

/** POST /returns/:id/inspect */
export interface InspectionResult {
  return: ReturnDetail;
  /** Cambio sin stock de la talla nueva: queda inspeccionado hasta reintentar el envío. */
  exchangePending: boolean;
}

export function photoPath(returnId: string, returnItemId: string, index: number): string {
  return `/returns/${returnId}/items/${returnItemId}/photos/${index}`;
}

// ---------------------------------------------------------------- Acciones según estado y permisos
export interface ReturnActions {
  approve: boolean;
  reject: boolean;
  receive: boolean;
  inspect: boolean;
  retryExchange: boolean;
}

/**
 * Acciones que este usuario puede hacer sobre la devolución, con las transiciones del agregado
 * (requested → approved/rejected; approved/pickup_scheduled → received; received →
 * inspected/rejected) y los permisos de cada endpoint del controller.
 */
export function returnActions(r: Pick<ReturnSummary, 'status' | 'type'>, permissions: readonly string[]): ReturnActions {
  const can = (p: string) => permissions.includes(p);
  return {
    approve: r.status === 'requested' && can('returns.approve'),
    reject: (r.status === 'requested' || r.status === 'received') && can('returns.approve'),
    receive: (r.status === 'approved' || r.status === 'pickup_scheduled') && can('returns.inspect'),
    inspect: r.status === 'received' && can('returns.inspect'),
    retryExchange: r.type === 'exchange' && r.status === 'inspected' && can('returns.inspect'),
  };
}

export interface RefundApprovalState {
  /** Aprobaciones hechas / exigidas ("1 de 2"). */
  done: number;
  required: number;
  /** Puede aprobar ahora mismo. */
  canApprove: boolean;
  /** Por qué no (si corresponde mostrarlo). */
  blockedReason: string | null;
}

/**
 * Aprobación del reembolso: pendiente, con payments.refund.approve, sin ser quien lo solicitó y sin
 * haberlo aprobado ya (la segunda aprobación de un monto alto la hace otra persona).
 */
export function refundApproval(refund: Refund, userId: string | null | undefined, permissions: readonly string[]): RefundApprovalState {
  const done = refund.approvals.length;
  const required = refund.requiredApprovals;
  const base = { done, required };
  if (refund.status !== 'pending') return { ...base, canApprove: false, blockedReason: null };
  if (!permissions.includes('payments.refund.approve')) return { ...base, canApprove: false, blockedReason: 'Tu rol no aprueba reembolsos.' };
  if (userId && refund.requestedBy === userId) return { ...base, canApprove: false, blockedReason: 'Quien solicitó el reembolso (la inspección) no puede aprobarlo.' };
  if (userId && refund.approvals.some((a) => a.userId === userId)) {
    return { ...base, canApprove: false, blockedReason: 'Ya lo aprobaste: la segunda aprobación debe hacerla otra persona.' };
  }
  return { ...base, canApprove: true, blockedReason: null };
}

// ---------------------------------------------------------------- Cola
export type ReturnStatusFilter = ReturnStatus | 'active' | '';

/** Filtro de la pantalla → query de GET /returns. */
export function returnsQuery(status: ReturnStatusFilter, limit: number, offset: number, orderId?: string): Record<string, string | number | readonly string[] | undefined> {
  return {
    status: status === 'active' ? ACTIVE_RETURN_STATUSES : status ? [status] : undefined,
    orderId: orderId || undefined,
    limit,
    offset,
  };
}

export function unitsOf(r: Pick<ReturnSummary, 'items'>): number {
  return r.items.reduce((n, i) => n + i.quantity, 0);
}

// ---------------------------------------------------------------- Registro por soporte
/** ¿Se puede registrar una devolución de este pedido? (entregado o ya parcialmente devuelto). */
export function canRegisterReturn(order: { status: OrderStatus }, permissions: readonly string[]): boolean {
  return RETURNABLE_ORDER_STATUSES.includes(order.status) && permissions.includes('returns.approve');
}

/**
 * Unidades que aún se pueden devolver de cada línea del pedido: compradas − ya devueltas − las que
 * están en solicitudes abiertas (igual que el agregado; si no, el API responde RETURN_QUANTITY_EXCEEDED).
 */
export function returnableQuantities(
  items: readonly Pick<OrderItem, 'id' | 'quantity' | 'qtyReturned'>[],
  returns: readonly Pick<ReturnSummary, 'status' | 'items'>[],
): Map<string, number> {
  const open = new Map<string, number>();
  for (const r of returns) {
    if (!OPEN_RETURN_STATUSES.includes(r.status)) continue;
    for (const i of r.items) open.set(i.orderItemId, (open.get(i.orderItemId) ?? 0) + i.quantity);
  }
  return new Map(items.map((i) => [i.id, Math.max(0, i.quantity - i.qtyReturned - (open.get(i.id) ?? 0))]));
}

export interface DraftLine {
  /** 0 = la línea no se devuelve. */
  quantity: number;
  reasonCode: ReturnReasonCode | '';
  exchangeVariantId: string;
}

export interface ReturnDraft {
  type: ReturnType;
  resolution: RefundResolution;
  reason: string;
  customerNotes: string;
  lines: Record<string, DraftLine>;
}

export function emptyDraft(): ReturnDraft {
  return { type: 'return', resolution: 'refund_original', reason: '', customerNotes: '', lines: {} };
}

/** Cuerpo de POST /returns. Las líneas en 0 no viajan; la resolución solo en devoluciones. */
export interface RegisterReturnBody {
  orderId: string;
  type: ReturnType;
  resolution?: RefundResolution;
  reason?: string;
  customerNotes?: string;
  items: { orderItemId: string; quantity: number; reasonCode: ReturnReasonCode; exchangeVariantId?: string }[];
}

export function buildRegisterBody(orderId: string, draft: ReturnDraft): RegisterReturnBody {
  const exchange = draft.type === 'exchange';
  const items = Object.entries(draft.lines)
    .filter(([, l]) => l.quantity > 0 && l.reasonCode)
    .map(([orderItemId, l]) => ({
      orderItemId,
      quantity: l.quantity,
      reasonCode: l.reasonCode as ReturnReasonCode,
      ...(exchange && l.exchangeVariantId ? { exchangeVariantId: l.exchangeVariantId } : {}),
    }));
  const reason = draft.reason.trim().slice(0, REASON_MAX);
  const notes = draft.customerNotes.trim().slice(0, NOTES_MAX);
  return {
    orderId,
    type: draft.type,
    ...(exchange ? {} : { resolution: draft.resolution }),
    ...(reason ? { reason } : {}),
    ...(notes ? { customerNotes: notes } : {}),
    items,
  };
}

/**
 * Errores del formulario antes de enviar (los mismos que respondería el API): al menos una línea,
 * cantidades dentro de lo devolvible, motivo por línea y talla nueva en los cambios. `warnings`:
 * fallas de la tienda registradas sin foto (la evidencia se toma en la inspección de bodega).
 */
export function validateDraft(draft: ReturnDraft, available: ReadonlyMap<string, number>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const chosen = Object.entries(draft.lines).filter(([, l]) => l.quantity > 0);
  if (chosen.length === 0) errors.push('Indica al menos un producto con cantidad a devolver.');
  for (const [id, l] of chosen) {
    const max = available.get(id) ?? 0;
    if (!Number.isInteger(l.quantity) || l.quantity > max) errors.push(`Una línea supera las unidades devolvibles (máx. ${max}).`);
    if (!l.reasonCode) errors.push('Elige el motivo de cada producto a devolver.');
    else if (PHOTO_REQUIRED_REASONS.has(l.reasonCode)) warnings.push(`"${REASON_LABEL[l.reasonCode]}" es una falla de la tienda: sin fotos del cliente, bodega la verificará al inspeccionar.`);
    if (draft.type === 'exchange' && !l.exchangeVariantId) errors.push('En un cambio elige la talla nueva de cada producto.');
  }
  if (draft.reason.length > REASON_MAX) errors.push(`El motivo admite hasta ${REASON_MAX} caracteres.`);
  if (draft.customerNotes.length > NOTES_MAX) errors.push(`Las notas admiten hasta ${NOTES_MAX} caracteres.`);
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

// ---------------------------------------------------------------- Inspección
export interface InspectionDraft {
  condition: ItemCondition;
  restock: boolean;
}

/** Valor inicial por línea: nuevo y de vuelta al stock (lo habitual); se corrige prenda por prenda. */
export function initialInspection(lines: readonly Pick<ReturnLine, 'returnItemId'>[]): Record<string, InspectionDraft> {
  return Object.fromEntries(lines.map((l) => [l.returnItemId, { condition: 'new', restock: true }]));
}

/** Cambiar la condición ajusta el reingreso sugerido: un dañado no vuelve al stock vendible. */
export function withCondition(d: InspectionDraft, condition: ItemCondition): InspectionDraft {
  return { condition, restock: condition === 'damaged' ? false : condition === 'new' ? true : d.restock };
}

/** Cuerpo de POST /returns/:id/inspect: todas las líneas (si falta una, INSPECTION_INCOMPLETE), en su orden. */
export function buildInspectBody(
  lines: readonly Pick<ReturnLine, 'returnItemId'>[],
  draft: Readonly<Record<string, InspectionDraft>>,
): { items: { returnItemId: string; condition: ItemCondition; restock: boolean }[] } {
  return {
    items: lines.map((l) => {
      const d = draft[l.returnItemId] ?? { condition: 'new' as const, restock: true };
      // Un dañado nunca vuelve al stock vendible (DAMAGED_NOT_RESTOCKABLE).
      return { returnItemId: l.returnItemId, condition: d.condition, restock: d.condition === 'damaged' ? false : d.restock };
    }),
  };
}
