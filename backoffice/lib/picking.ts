import type { FulfillmentType, OrderStatus, PaymentMethod } from './orders';
import { normalizeBarcode } from './scanner';

/**
 * Picking de bodega (/v1/fulfillment/picking): tipos del API y conteo puro de lo escaneado.
 * El servidor exige EXACTAMENTE lo pedido al cerrar (PICK_INCOMPLETE / PICK_EXCESS); aquí se
 * evita llegar a eso: no se cuenta de más y "Completar" se habilita solo con todo recogido.
 */

export type PickState = 'to_pick' | 'picking';

export const PICK_STATE_LABEL: Record<PickState, string> = {
  to_pick: 'Por preparar',
  picking: 'En preparación',
};

export interface DeliverySlot {
  startsAt: string;
  endsAt: string;
}

export interface PickingQueueEntry {
  orderId: string;
  orderNumber: string | null;
  status: OrderStatus;
  placedAt: string;
  fulfillmentType: FulfillmentType;
  paymentMethod: PaymentMethod;
  warehouseId: string | null;
  deliverySlot: DeliverySlot | null;
  itemCount: number;
  unitCount: number;
  customerName: string;
}

export interface PickingItem {
  orderItemId: string;
  variantId: string;
  sku: string;
  barcode: string | null;
  productName: string;
  color: string | null;
  size: string | null;
  /** Unidades a recoger (pedidas menos devueltas). */
  quantity: number;
  imageUrl: string | null;
}

export interface PickingDetail {
  orderId: string;
  orderNumber: string | null;
  status: OrderStatus;
  version: number;
  fulfillmentType: FulfillmentType;
  warehouseId: string | null;
  notes: string | null;
  deliverySlot: DeliverySlot | null;
  shipmentStatus: string | null;
  items: PickingItem[];
}

export interface PickingHeader {
  orderId: string;
  orderNumber: string | null;
  status: OrderStatus;
  version: number;
  fulfillmentType: FulfillmentType;
  warehouseId: string | null;
}

export type CompletePickingResult = PickingHeader & { shipment: { id: string; carrierType: string; status: string } };

/** Unidades recogidas por orderItemId. */
export type Picked = Record<string, number>;

export type PickScan =
  | { kind: 'ok'; item: PickingItem; picked: Picked }
  | { kind: 'not_in_order' }
  | { kind: 'excess'; item: PickingItem };

const sameCode = (a: string, b: string) => normalizeBarcode(a).toLowerCase() === normalizeBarcode(b).toLowerCase();

/** Línea(s) del pedido que corresponden a un código: por código de barras o, si no hay, por SKU (QR con el SKU). */
export function itemsForCode(items: PickingItem[], code: string): PickingItem[] {
  const byBarcode = items.filter((i) => i.barcode && sameCode(i.barcode, code));
  return byBarcode.length > 0 ? byBarcode : items.filter((i) => sameCode(i.sku, code));
}

/**
 * Lectura de una prenda: suma 1 a la primera línea de ese código que aún tenga pendiente. Si el
 * código no es del pedido → not_in_order; si todas sus líneas ya están completas → excess.
 */
export function registerPick(items: PickingItem[], picked: Picked, code: string): PickScan {
  const matches = itemsForCode(items, code);
  if (matches.length === 0) return { kind: 'not_in_order' };
  const target = matches.find((i) => (picked[i.orderItemId] ?? 0) < i.quantity);
  if (!target) return { kind: 'excess', item: matches[0] };
  return { kind: 'ok', item: target, picked: { ...picked, [target.orderItemId]: (picked[target.orderItemId] ?? 0) + 1 } };
}

/** Ajuste manual +/- (prendas sin código), acotado a [0, pedido]. */
export function adjustPick(items: PickingItem[], picked: Picked, orderItemId: string, delta: number): Picked {
  const item = items.find((i) => i.orderItemId === orderItemId);
  if (!item) return picked;
  const next = Math.min(Math.max(0, (picked[orderItemId] ?? 0) + delta), item.quantity);
  return { ...picked, [orderItemId]: next };
}

export function pickProgress(items: PickingItem[], picked: Picked) {
  let total = 0;
  let done = 0;
  for (const i of items) {
    total += i.quantity;
    done += Math.min(picked[i.orderItemId] ?? 0, i.quantity);
  }
  return { total, done, complete: total > 0 && done === total, ratio: total === 0 ? 0 : done / total };
}

/** Cuerpo de POST /complete: todas las líneas con lo recogido. */
export function completeBody(items: PickingItem[], picked: Picked): { items: { orderItemId: string; pickedQuantity: number }[] } {
  return { items: items.map((i) => ({ orderItemId: i.orderItemId, pickedQuantity: picked[i.orderItemId] ?? 0 })) };
}

/** Quita líneas que ya no existen y recorta lo que excede lo pedido (p. ej. tras una devolución). */
export function sanitizePicked(items: PickingItem[], picked: Picked): Picked {
  const out: Picked = {};
  for (const i of items) {
    const n = Math.min(Math.max(0, Math.trunc(picked[i.orderItemId] ?? 0)), i.quantity);
    if (n > 0) out[i.orderItemId] = n;
  }
  return out;
}

interface PickDiff {
  orderItemId: string;
  expected: number;
  picked: number;
}

/** Detalle de un 422 PICK_EXCESS / PICK_INCOMPLETE en frases legibles. */
export function pickErrorLines(items: PickingItem[], details: unknown): string[] {
  const d = (details ?? {}) as { missing?: PickDiff[]; excess?: PickDiff[] };
  const name = (id: string) => {
    const i = items.find((x) => x.orderItemId === id);
    return i ? `${i.productName}${i.size ? ` talla ${i.size}` : ''} (${i.sku})` : 'Línea que no es del pedido';
  };
  return [
    ...(d.excess ?? []).map((x) => `Sobran ${x.picked - x.expected}: ${name(x.orderItemId)} — pedido ${x.expected}, recogido ${x.picked}`),
    ...(d.missing ?? []).map((x) => `Faltan ${x.expected - x.picked}: ${name(x.orderItemId)} — pedido ${x.expected}, recogido ${x.picked}`),
  ];
}

// ---------------------------------------------------------------- Persistencia del avance
const key = (orderId: string) => `bo.picking.${orderId}`;

/** Avance guardado (sessionStorage), o {} si no hay o el almacenamiento está bloqueado. */
export function loadPicked(orderId: string, storage: Pick<Storage, 'getItem'> | undefined = globalThis.sessionStorage): Picked {
  try {
    const raw = storage?.getItem(key(orderId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Picked = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'number' && v > 0) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function savePicked(
  orderId: string,
  picked: Picked,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.sessionStorage,
): void {
  try {
    if (Object.values(picked).some((n) => n > 0)) storage?.setItem(key(orderId), JSON.stringify(picked));
    else storage?.removeItem(key(orderId));
  } catch {
    // Sin almacenamiento: el avance vive solo en memoria.
  }
}

export function clearPicked(orderId: string, storage: Pick<Storage, 'removeItem'> | undefined = globalThis.sessionStorage): void {
  try {
    storage?.removeItem(key(orderId));
  } catch {
    // Nada que limpiar.
  }
}
