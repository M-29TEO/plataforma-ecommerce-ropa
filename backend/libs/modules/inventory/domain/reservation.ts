import { ValidationError } from '../../../shared-kernel';
import { compareStockKey } from './stock';

export type ReservationStatus = 'active' | 'consumed' | 'released';

export interface Reservation {
  id: string;
  variantId: string;
  warehouseId: string;
  orderId: string;
  quantity: number;
  status: ReservationStatus;
  expiresAt: Date;
  createdAt: Date;
}

export interface ReservationLine {
  variantId: string;
  warehouseId: string;
  quantity: number;
}

export const MAX_RESERVATION_LINES = 100;

/**
 * Prepara las líneas de una reserva:
 *  - valida cantidades (enteros positivos),
 *  - agrupa líneas repetidas de la misma variante y bodega,
 *  - ORDENA por (variant_id, warehouse_id).
 *
 * El orden es lo que evita deadlocks: dos pedidos con las mismas variantes siempre
 * bloquean las filas de stock_levels en la misma secuencia, así que uno espera al otro
 * en lugar de esperarse mutuamente.
 */
export function normalizeReservationLines(lines: ReservationLine[]): ReservationLine[] {
  if (lines.length === 0) throw new ValidationError('EMPTY_RESERVATION', 'La reserva no tiene líneas');
  if (lines.length > MAX_RESERVATION_LINES) {
    throw new ValidationError('TOO_MANY_LINES', `Máximo ${MAX_RESERVATION_LINES} líneas por reserva`);
  }

  const merged = new Map<string, ReservationLine>();
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new ValidationError('INVALID_QUANTITY', 'Las cantidades deben ser enteros positivos', { ...line });
    }
    const key = `${line.variantId}|${line.warehouseId}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, quantity: prev.quantity + line.quantity } : { ...line });
  }
  return [...merged.values()].sort(compareStockKey);
}

/** Suma cantidades por (variante, bodega) y devuelve el resultado ordenado. */
export function aggregateByStockKey<T extends ReservationLine>(rows: T[]): ReservationLine[] {
  const totals = new Map<string, ReservationLine>();
  for (const r of rows) {
    const key = `${r.variantId}|${r.warehouseId}`;
    const prev = totals.get(key);
    totals.set(key, {
      variantId: r.variantId,
      warehouseId: r.warehouseId,
      quantity: (prev?.quantity ?? 0) + r.quantity,
    });
  }
  return [...totals.values()].sort(compareStockKey);
}
