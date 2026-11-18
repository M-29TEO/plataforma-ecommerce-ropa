import { AdjustmentBelowReservedError, InvalidAdjustmentError } from './errors';

export interface StockLevel {
  variantId: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
  /** on_hand - reserved (columna generada en PostgreSQL). */
  available: number;
  reorderPoint: number;
  reorderQty: number;
  binLocation: string | null;
  version: number;
  updatedAt: Date;
}

/**
 * Tipos de movimiento del ledger. stock_movements registra SOLO cambios de on_hand
 * (mercadería física); los compromisos (reserved) quedan en stock_reservations.
 * Invariante: SUM(quantity) por (variante, bodega) = on_hand.
 */
export type MovementType =
  | 'purchase'
  | 'sale'
  | 'return'
  | 'adjustment'
  | 'transfer_in'
  | 'transfer_out'
  | 'damage'
  | 'count';

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
  createdAt: Date;
}

export type NewStockMovement = Omit<StockMovement, 'id' | 'createdAt'>;

/** Orden total de las filas de stock_levels. Toda transacción que bloquee varias filas usa este orden. */
export function compareStockKey(
  a: { variantId: string; warehouseId: string },
  b: { variantId: string; warehouseId: string },
): number {
  if (a.variantId !== b.variantId) return a.variantId < b.variantId ? -1 : 1;
  if (a.warehouseId !== b.warehouseId) return a.warehouseId < b.warehouseId ? -1 : 1;
  return 0;
}

/**
 * Regla del evento StockBelowThreshold: se emite al CRUZAR el punto de reorden
 * (antes por encima, ahora en o por debajo), no en cada operación posterior.
 */
export function crossedBelowThreshold(availableBefore: number, availableAfter: number, reorderPoint: number): boolean {
  return availableBefore > reorderPoint && availableAfter <= reorderPoint;
}

export type AdjustmentCommand =
  | { type: 'adjustment'; delta: number }
  | { type: 'damage'; quantity: number }
  | { type: 'count'; countedQuantity: number };

/**
 * Calcula el delta de on_hand de un ajuste manual y valida que el resultado sea coherente.
 * current = null cuando la variante aún no tiene fila de stock en la bodega.
 */
export function planAdjustment(
  current: { onHand: number; reserved: number } | null,
  cmd: AdjustmentCommand,
): { delta: number; newOnHand: number } {
  const onHand = current?.onHand ?? 0;
  const reserved = current?.reserved ?? 0;
  let delta: number;

  switch (cmd.type) {
    case 'adjustment':
      if (!Number.isInteger(cmd.delta) || cmd.delta === 0) {
        throw new InvalidAdjustmentError('El ajuste debe ser un entero distinto de cero');
      }
      delta = cmd.delta;
      break;
    case 'damage':
      if (!Number.isInteger(cmd.quantity) || cmd.quantity <= 0) {
        throw new InvalidAdjustmentError('La cantidad dañada debe ser un entero positivo');
      }
      delta = -cmd.quantity;
      break;
    case 'count':
      if (!Number.isInteger(cmd.countedQuantity) || cmd.countedQuantity < 0) {
        throw new InvalidAdjustmentError('El conteo físico debe ser un entero no negativo');
      }
      // Un conteo que coincide se registra igual (delta 0): deja evidencia de la auditoría física.
      delta = cmd.countedQuantity - onHand;
      break;
  }

  const newOnHand = onHand + delta;
  if (newOnHand < reserved) throw new AdjustmentBelowReservedError({ onHand, reserved, delta });
  return { delta, newOnHand };
}
