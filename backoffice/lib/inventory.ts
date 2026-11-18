import type { Tone } from '@/components/ui/Badge';

/**
 * Tipos de las respuestas del módulo Inventario (/v1/inventory/...) y lógica pura de Bodega:
 * recepción de compras, ajustes de stock y alertas de reposición.
 */

// ---------------------------------------------------------------- Bodegas y proveedores
export type WarehouseType = 'warehouse' | 'store' | 'dark_store';

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  type: WarehouseType;
  address: Record<string, unknown>;
  location: { lat: number; lng: number };
  city: string;
  isPickupPoint: boolean;
  shipsOnline: boolean;
  active: boolean;
}

export const WAREHOUSE_TYPE_LABEL: Record<WarehouseType, string> = {
  warehouse: 'Bodega',
  store: 'Tienda',
  dark_store: 'Dark store',
};

export function warehouseLabel(w: Pick<Warehouse, 'code' | 'name'> | undefined, fallbackId?: string): string {
  if (!w) return fallbackId ? `Bodega ${shortId(fallbackId)}` : '—';
  return `${w.code} · ${w.name}`;
}

export interface Supplier {
  id: string;
  name: string;
  ruc: string | null;
  contact: { name?: string; email?: string; phone?: string; address?: string };
  leadTimeDays: number | null;
  active: boolean;
}

// ---------------------------------------------------------------- Órdenes de compra
export type PurchaseOrderStatus = 'draft' | 'sent' | 'partially_received' | 'received' | 'cancelled';

export interface PurchaseOrderItem {
  id: string;
  variantId: string;
  qtyOrdered: number;
  qtyReceived: number;
  unitCost: string;
}

export interface PurchaseOrder {
  id: string;
  supplierId: string;
  warehouseId: string;
  number: string;
  status: PurchaseOrderStatus;
  expectedAt: string | null;
  total: string;
  createdBy: string | null;
  createdAt: string;
  items: PurchaseOrderItem[];
}

export const PO_STATUS: Record<PurchaseOrderStatus, [string, Tone]> = {
  draft: ['Borrador', 'neutral'],
  sent: ['Enviada', 'info'],
  partially_received: ['Recibida parcial', 'warn'],
  received: ['Recibida', 'ok'],
  cancelled: ['Cancelada', 'danger'],
};

/** Estados en los que se puede registrar una recepción. */
export const RECEIVABLE: readonly PurchaseOrderStatus[] = ['sent', 'partially_received'];

export const canReceive = (s: PurchaseOrderStatus) => RECEIVABLE.includes(s);
export const canSend = (s: PurchaseOrderStatus) => s === 'draft';
/** Solo antes de recibir mercadería (lo recibido ya está en el ledger). */
export const canCancel = (s: PurchaseOrderStatus) => s === 'draft' || s === 'sent';

export function pendingOf(item: Pick<PurchaseOrderItem, 'qtyOrdered' | 'qtyReceived'>): number {
  return Math.max(0, item.qtyOrdered - item.qtyReceived);
}

/** Totales de la orden: pedido, ya recibido, pendiente y lo que se recibe ahora. */
export function poProgress(items: PurchaseOrderItem[], counts: Record<string, number> = {}) {
  let ordered = 0;
  let received = 0;
  let now = 0;
  for (const i of items) {
    ordered += i.qtyOrdered;
    received += i.qtyReceived;
    now += counts[i.id] ?? 0;
  }
  return { ordered, received, pending: ordered - received, now, remainingAfter: ordered - received - now };
}

export type ScanOutcome =
  | { kind: 'ok'; itemId: string; counts: Record<string, number> }
  | { kind: 'not_in_order' }
  | { kind: 'complete'; itemId: string };

/**
 * Una prenda escaneada suma 1 a la línea de su variante. Rechaza variantes que no están en la
 * orden y lecturas que superarían lo pendiente (el API respondería OVER_RECEIPT).
 */
export function registerScan(items: PurchaseOrderItem[], counts: Record<string, number>, variantId: string): ScanOutcome {
  const item = items.find((i) => i.variantId === variantId);
  if (!item) return { kind: 'not_in_order' };
  const current = counts[item.id] ?? 0;
  if (current + 1 > pendingOf(item)) return { kind: 'complete', itemId: item.id };
  return { kind: 'ok', itemId: item.id, counts: { ...counts, [item.id]: current + 1 } };
}

/** Cantidad tecleada para una línea, acotada a [0, pendiente]. */
export function setLineQty(items: PurchaseOrderItem[], counts: Record<string, number>, itemId: string, qty: number): Record<string, number> {
  const item = items.find((i) => i.id === itemId);
  if (!item) return counts;
  const n = Number.isFinite(qty) ? Math.trunc(qty) : 0;
  return { ...counts, [itemId]: Math.min(Math.max(0, n), pendingOf(item)) };
}

/** "Recibir todo lo pendiente". */
export function fillPending(items: PurchaseOrderItem[]): Record<string, number> {
  return Object.fromEntries(items.filter((i) => pendingOf(i) > 0).map((i) => [i.id, pendingOf(i)]));
}

/** Cuerpo de POST /purchase-orders/:id/receipts: solo líneas con cantidad > 0. */
export function receiptLines(items: PurchaseOrderItem[], counts: Record<string, number>): { itemId: string; quantity: number }[] {
  return items
    .map((i) => ({ itemId: i.id, quantity: Math.min(counts[i.id] ?? 0, pendingOf(i)) }))
    .filter((l) => l.quantity > 0);
}

/** Costo unitario como lo pide el DTO: hasta 10 enteros y 2 decimales ("12.50"). */
export function normalizeUnitCost(raw: string): string | null {
  const v = raw.trim().replace(',', '.');
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(v)) return null;
  return Number(v).toFixed(2);
}

// ---------------------------------------------------------------- Stock
export interface StockLevel {
  variantId: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderPoint: number;
  reorderQty: number;
  binLocation: string | null;
  version: number;
  updatedAt: string;
}

/** Mismo criterio que el filtro belowReorderPoint del API: disponible <= punto de reorden. */
export function isLowStock(l: Pick<StockLevel, 'available' | 'reorderPoint'>): boolean {
  return l.available <= l.reorderPoint;
}

export function stockTone(l: Pick<StockLevel, 'available' | 'reorderPoint'>): [string, Tone] {
  if (l.available <= 0) return ['Sin stock', 'danger'];
  if (isLowStock(l)) return ['Stock bajo', 'warn'];
  return ['OK', 'ok'];
}

export type MovementType = 'purchase' | 'sale' | 'return' | 'adjustment' | 'transfer_in' | 'transfer_out' | 'damage' | 'count';

export interface StockMovement {
  id: string;
  variantId: string;
  warehouseId: string;
  quantity: number;
  movementType: MovementType;
  referenceType: string | null;
  referenceId: string | null;
  unitCost: string | null;
  reason: string | null;
  userId: string | null;
  createdAt: string;
}

export const MOVEMENT_TYPE: Record<MovementType, [string, Tone]> = {
  purchase: ['Compra', 'ok'],
  sale: ['Venta', 'info'],
  return: ['Devolución', 'accent'],
  adjustment: ['Ajuste', 'neutral'],
  transfer_in: ['Transferencia entrada', 'ok'],
  transfer_out: ['Transferencia salida', 'warn'],
  damage: ['Merma / daño', 'danger'],
  count: ['Conteo físico', 'neutral'],
};

export interface Reservation {
  id: string;
  variantId: string;
  warehouseId: string;
  orderId: string;
  quantity: number;
  status: 'active' | 'consumed' | 'released';
  expiresAt: string;
  createdAt: string;
}

export const RESERVATION_STATUS: Record<Reservation['status'], [string, Tone]> = {
  active: ['Activa', 'info'],
  consumed: ['Consumida', 'ok'],
  released: ['Liberada', 'neutral'],
};

// ---------------------------------------------------------------- Ajustes
/** Tipos del DTO AdjustStockDto (ADJUSTMENT_TYPES). */
export type AdjustmentType = 'adjustment' | 'damage' | 'count';

export const ADJUSTMENT_TYPES: { value: AdjustmentType; label: string; help: string; qtyLabel: string }[] = [
  { value: 'adjustment', label: 'Corrección (+/−)', help: 'Suma o resta unidades: +3 encontradas, −2 faltantes.', qtyLabel: 'Cantidad (+/−)' },
  { value: 'damage', label: 'Merma / daño', help: 'Unidades dañadas o perdidas: siempre salen del stock.', qtyLabel: 'Unidades dañadas' },
  { value: 'count', label: 'Conteo físico', help: 'Cuántas unidades hay realmente; el sistema calcula la diferencia.', qtyLabel: 'Unidades contadas' },
];

/** Límites del DTO. */
export const MAX_DELTA = 100_000;
export const MAX_QTY = 1_000_000;

export interface AdjustmentPreview {
  delta: number;
  newOnHand: number;
  error: string | null;
}

/**
 * Replica planAdjustment del dominio para avisar ANTES de enviar: delta, on_hand resultante y si el
 * ajuste sería rechazado (cantidad inválida o quedaría menos físico que lo reservado).
 */
export function previewAdjustment(
  current: Pick<StockLevel, 'onHand' | 'reserved'> | null,
  type: AdjustmentType,
  qty: number,
): AdjustmentPreview {
  const onHand = current?.onHand ?? 0;
  const reserved = current?.reserved ?? 0;
  let delta = 0;
  let error: string | null = null;
  if (!Number.isInteger(qty)) error = 'Ingresa un número entero';
  else if (type === 'adjustment') {
    if (qty === 0) error = 'La corrección no puede ser 0';
    else if (Math.abs(qty) > MAX_DELTA) error = `Máximo ±${MAX_DELTA.toLocaleString('es-EC')} por ajuste`;
    delta = qty;
  } else if (type === 'damage') {
    if (qty <= 0) error = 'Las unidades dañadas deben ser al menos 1';
    else if (qty > MAX_QTY) error = 'Cantidad demasiado alta';
    delta = -qty;
  } else {
    if (qty < 0) error = 'El conteo no puede ser negativo';
    else if (qty > MAX_QTY) error = 'Cantidad demasiado alta';
    delta = qty - onHand;
  }
  const newOnHand = onHand + delta;
  if (!error && newOnHand < reserved) {
    error = `Quedarían ${newOnHand} unidades físicas y hay ${reserved} reservadas para pedidos`;
  }
  return { delta, newOnHand, error };
}

/** Cuerpo de POST /inventory/stock/adjustments según el tipo. */
export function adjustmentBody(input: { variantId: string; warehouseId: string; type: AdjustmentType; qty: number; reason: string }) {
  const base = { variantId: input.variantId, warehouseId: input.warehouseId, type: input.type, reason: input.reason.trim() };
  if (input.type === 'adjustment') return { ...base, delta: input.qty };
  if (input.type === 'damage') return { ...base, quantity: input.qty };
  return { ...base, countedQuantity: input.qty };
}

/** El DTO exige motivo de 3 a 500 caracteres. */
export function validReason(reason: string): boolean {
  const r = reason.trim();
  return r.length >= 3 && r.length <= 500;
}

export const REASON_SUGGESTIONS = ['Inventario inicial', 'Conteo cíclico', 'Prenda dañada', 'Faltante en percha', 'Sobrante encontrado', 'Error de registro'];

// ---------------------------------------------------------------- Utilidades
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
