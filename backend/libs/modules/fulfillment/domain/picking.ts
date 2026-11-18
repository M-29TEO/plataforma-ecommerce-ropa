import { ValidationError } from '../../../shared-kernel';

/**
 * Picking de bodega: el operador escanea cada unidad (el front verifica el código de barras contra
 * el detalle) y al cerrar envía cuántas recogió por línea. El servidor exige exactamente lo pedido.
 */
export const PICK_STATES = ['to_pick', 'picking'] as const;
export type PickState = (typeof PICK_STATES)[number];

/** Línea del pedido a recoger: unidades pedidas (menos las ya devueltas, que en preparación son 0). */
export interface PickLine {
  orderItemId: string;
  quantity: number;
}

export interface PickedLine {
  orderItemId: string;
  pickedQuantity: number;
}

export interface PickDiff {
  orderItemId: string;
  expected: number;
  picked: number;
}

export class PickIncompleteError extends ValidationError {
  constructor(missing: PickDiff[]) {
    super('PICK_INCOMPLETE', 'Faltan unidades por recoger', { missing });
  }
}

export class PickExcessError extends ValidationError {
  constructor(excess: PickDiff[]) {
    super('PICK_EXCESS', 'Se recogieron más unidades de las pedidas (o líneas que no son del pedido)', { excess });
  }
}

/**
 * Compara lo recogido con lo pedido. Una línea repetida en el cuerpo suma; una línea que no es del
 * pedido cuenta como sobrante (expected 0). Las listas salen en el orden del pedido.
 */
export function comparePick(lines: PickLine[], picked: PickedLine[]): { missing: PickDiff[]; excess: PickDiff[] } {
  const pickedBy = new Map<string, number>();
  for (const p of picked) pickedBy.set(p.orderItemId, (pickedBy.get(p.orderItemId) ?? 0) + p.pickedQuantity);

  const missing: PickDiff[] = [];
  const excess: PickDiff[] = [];
  const known = new Set<string>();
  for (const l of lines) {
    known.add(l.orderItemId);
    const got = pickedBy.get(l.orderItemId) ?? 0;
    if (got < l.quantity) missing.push({ orderItemId: l.orderItemId, expected: l.quantity, picked: got });
    else if (got > l.quantity) excess.push({ orderItemId: l.orderItemId, expected: l.quantity, picked: got });
  }
  for (const [orderItemId, got] of pickedBy) {
    if (!known.has(orderItemId) && got > 0) excess.push({ orderItemId, expected: 0, picked: got });
  }
  return { missing, excess };
}

/** Sobrantes primero (un escaneo equivocado se corrige antes de buscar lo que falta). */
export function assertPickComplete(lines: PickLine[], picked: PickedLine[]): void {
  const { missing, excess } = comparePick(lines, picked);
  if (excess.length > 0) throw new PickExcessError(excess);
  if (missing.length > 0) throw new PickIncompleteError(missing);
}

/** Lo que importa para ordenar la cola. */
export interface QueueSortKey {
  slotStartsAt: Date | null;
  placedAt: Date;
  orderNumber: string | null;
}

/**
 * Orden de la cola: primero los que tienen franja de entrega (la más próxima primero, porque el
 * motorizado sale a esa hora); después el resto por antigüedad. Desempate por número de pedido.
 */
export function compareQueue(a: QueueSortKey, b: QueueSortKey): number {
  if (a.slotStartsAt && b.slotStartsAt) {
    const d = a.slotStartsAt.getTime() - b.slotStartsAt.getTime();
    if (d !== 0) return d;
  } else if (a.slotStartsAt || b.slotStartsAt) {
    return a.slotStartsAt ? -1 : 1;
  }
  const d = a.placedAt.getTime() - b.placedAt.getTime();
  if (d !== 0) return d;
  return Number(a.orderNumber ?? 0) - Number(b.orderNumber ?? 0);
}
