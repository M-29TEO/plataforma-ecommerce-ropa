import { DomainEvent } from '../../../shared-kernel';

export const CART_ABANDONED = 'CartAbandoned';

export interface CartAbandonedLine {
  variantId: string;
  productName: string | null;
  colorName: string | null;
  sizeCode: string | null;
  quantity: number;
  /** Precio vigente SIN IVA (o el del momento de agregar si ya no se vende). */
  unitPrice: string;
}

/**
 * Consumidores: Notificaciones (recordatorio de marketing: exige consentimiento). Uno por etapa;
 * stage 3 es el último.
 */
export interface CartAbandonedPayload {
  cartId: string;
  stage: number;
  /** '1h' | '24h' | '72h' */
  stageLabel: string;
  userId: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  currency: string;
  itemCount: number;
  /** Total con descuentos e IVA según el precio vigente. null si no se pudo calcular. */
  total: string | null;
  lines: CartAbandonedLine[];
  lastActivityAt: string;
}

export function cartAbandoned(tenantId: string, payload: CartAbandonedPayload): DomainEvent {
  return { tenantId, aggregateType: 'sales.cart', aggregateId: payload.cartId, eventType: CART_ABANDONED, payload: { ...payload } };
}
