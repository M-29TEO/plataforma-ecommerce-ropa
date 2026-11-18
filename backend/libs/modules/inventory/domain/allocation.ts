import { ConflictError, ValidationError } from '../../../shared-kernel';
import { ReservationLine } from './reservation';

export interface AllocationItem {
  variantId: string;
  quantity: number;
}

/** Disponible de una variante en una bodega. */
export interface WarehouseAvailability {
  variantId: string;
  warehouseId: string;
  available: number;
}

/** Mismo código que la reserva: para el cliente es lo mismo (no alcanza el stock). */
export class AllocationShortageError extends ConflictError {
  constructor(shortages: { variantId: string; requested: number; available: number }[]) {
    super('INSUFFICIENT_STOCK', 'Stock insuficiente para completar el pedido', { shortages });
  }
}

/**
 * Decide de qué bodega sale cada línea (función pura; la reserva atómica viene después):
 *  1. Con warehouseId (retiro en tienda): todo sale de esa bodega.
 *  2. Si una sola bodega cubre todo el pedido, esa (un solo despacho). Entre varias, la de más
 *     unidades disponibles; a igualdad, la de menor id (determinista).
 *  3. Si no, cada variante se reparte entre bodegas, de la que más tiene a la que menos.
 * Si no alcanza, AllocationShortageError con lo que falta por variante.
 */
export function planAllocation(
  items: AllocationItem[],
  stock: WarehouseAvailability[],
  opts: { warehouseId?: string | null } = {},
): ReservationLine[] {
  const requested = new Map<string, number>();
  for (const i of items) {
    if (!Number.isInteger(i.quantity) || i.quantity <= 0) {
      throw new ValidationError('INVALID_QUANTITY', 'Las cantidades deben ser enteros positivos', { ...i });
    }
    requested.set(i.variantId, (requested.get(i.variantId) ?? 0) + i.quantity);
  }
  const rows = stock.filter((s) => s.available > 0 && (!opts.warehouseId || s.warehouseId === opts.warehouseId));
  const availableIn = (variantId: string, warehouseId: string) =>
    rows.find((r) => r.variantId === variantId && r.warehouseId === warehouseId)?.available ?? 0;

  const shortages = [...requested]
    .map(([variantId, qty]) => ({
      variantId,
      requested: qty,
      available: rows.filter((r) => r.variantId === variantId).reduce((s, r) => s + r.available, 0),
    }))
    .filter((s) => s.available < s.requested);
  if (shortages.length > 0) throw new AllocationShortageError(shortages);

  const warehouses = [...new Set(rows.map((r) => r.warehouseId))].sort();
  const single = warehouses
    .filter((w) => [...requested].every(([v, qty]) => availableIn(v, w) >= qty))
    .map((w) => ({ w, total: rows.filter((r) => r.warehouseId === w).reduce((s, r) => s + r.available, 0) }))
    .sort((a, b) => b.total - a.total || (a.w < b.w ? -1 : 1))[0];
  if (single) return [...requested].map(([variantId, quantity]) => ({ variantId, warehouseId: single.w, quantity }));

  const lines: ReservationLine[] = [];
  for (const [variantId, qty] of requested) {
    let pending = qty;
    const sources = rows
      .filter((r) => r.variantId === variantId)
      .sort((a, b) => b.available - a.available || (a.warehouseId < b.warehouseId ? -1 : 1));
    for (const s of sources) {
      if (pending === 0) break;
      const take = Math.min(pending, s.available);
      lines.push({ variantId, warehouseId: s.warehouseId, quantity: take });
      pending -= take;
    }
  }
  return lines;
}
