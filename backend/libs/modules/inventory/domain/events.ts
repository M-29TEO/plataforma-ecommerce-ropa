import { DomainEvent } from '../../../shared-kernel';

export const STOCK_BELOW_THRESHOLD = 'StockBelowThreshold';

/**
 * Emitido cuando el disponible de una variante en una bodega cruza su punto de reorden.
 * Consumidores previstos: Notificaciones (alerta a bodega) y Compras (sugerir reposición).
 */
export interface StockBelowThresholdPayload {
  variantId: string;
  warehouseId: string;
  available: number;
  reorderPoint: number;
  reorderQty: number;
  cause: 'reservation' | 'adjustment';
}

/**
 * stock_levels tiene PK compuesta; el agregado se identifica por variant_id y la bodega
 * viaja en el payload (aggregate_id del outbox es uuid).
 */
export function stockBelowThreshold(tenantId: string, payload: StockBelowThresholdPayload): DomainEvent {
  return {
    tenantId,
    aggregateType: 'inventory.stock_level',
    aggregateId: payload.variantId,
    eventType: STOCK_BELOW_THRESHOLD,
    payload: { ...payload },
  };
}
