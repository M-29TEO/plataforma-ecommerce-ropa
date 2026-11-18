import { CoverageZone } from './zone';

export type CourierReason =
  /** El punto no cae en ninguna zona propia. */
  | 'NO_ZONE'
  /** La zona existe pero solo se atiende por courier. */
  | 'COURIER_ONLY_ZONE'
  /** El paquete supera el peso máximo que lleva el motorizado en esa zona. */
  | 'OVERWEIGHT'
  /** No queda franja con cupo (o todas cerraron) en los próximos días. */
  | 'NO_SLOT_CAPACITY';

export type DeliveryDecision = { type: 'rider' } | { type: 'courier'; reason: CourierReason };

export interface DeliveryRulesInput {
  zone: Pick<CoverageZone, 'deliveryMode' | 'maxWeightKg' | 'active'> | null;
  /** Peso real del paquete (lo que carga el motorizado). */
  weightKg: number;
  /** Franjas de la zona con cupo y sin cerrar. */
  bookableSlots: number;
}

/**
 * DeliveryRulesEngine (enunciado: "si hay motorizado en zona → asignar; si no → cotizar
 * couriers"): motorizado propio si el punto cae en una zona activa que lo admite ('rider' o
 * 'both'), el paquete no excede su peso máximo y hay al menos una franja con cupo. En cualquier
 * otro caso, courier. El motivo se devuelve para mostrarlo en el checkout y en los reportes.
 */
export function decideDelivery(input: DeliveryRulesInput): DeliveryDecision {
  const { zone } = input;
  if (!zone || !zone.active) return { type: 'courier', reason: 'NO_ZONE' };
  if (zone.deliveryMode === 'courier') return { type: 'courier', reason: 'COURIER_ONLY_ZONE' };
  if (input.weightKg > zone.maxWeightKg) return { type: 'courier', reason: 'OVERWEIGHT' };
  if (input.bookableSlots === 0) return { type: 'courier', reason: 'NO_SLOT_CAPACITY' };
  return { type: 'rider' };
}
