import { Channel, MARKETING_PURPOSE, TemplateCategory } from './channel';

export interface CatalogEntry {
  category: TemplateCategory;
  /** Canales por los que sale, en orden. Un canal sin plantilla para el idioma se salta. */
  channels: readonly Channel[];
  /** Destinatario: el cliente del pedido/carrito o el backoffice (tópico ntfy). */
  audience: 'customer' | 'staff';
  description: string;
}

/**
 * Catálogo de plantillas: qué mensajes existen, su categoría y por qué canales salen. La categoría
 * la fija el catálogo (no la fila de notification_templates): un tenant no puede volver
 * "transaccional" un mensaje de marketing para saltarse el consentimiento.
 */
export const TEMPLATE_CATALOG = {
  'order.placed': { category: 'transactional', channels: ['email', 'webpush', 'whatsapp'], audience: 'customer', description: 'Pedido recibido' },
  'order.paid': { category: 'transactional', channels: ['email', 'webpush'], audience: 'customer', description: 'Pago confirmado' },
  'order.cancelled': { category: 'transactional', channels: ['email', 'webpush'], audience: 'customer', description: 'Pedido cancelado' },
  'order.delivered': { category: 'transactional', channels: ['email', 'webpush'], audience: 'customer', description: 'Pedido entregado' },
  'shipment.assigned': { category: 'transactional', channels: ['webpush'], audience: 'customer', description: 'Envío asignado a un motorizado o courier' },
  'shipment.picked_up': { category: 'transactional', channels: ['webpush'], audience: 'customer', description: 'Paquete retirado de bodega' },
  'shipment.in_transit': { category: 'transactional', channels: ['webpush', 'email'], audience: 'customer', description: 'Envío en camino' },
  'shipment.arriving': { category: 'transactional', channels: ['webpush', 'sms'], audience: 'customer', description: 'El repartidor está por llegar' },
  'shipment.delivered': { category: 'transactional', channels: ['webpush'], audience: 'customer', description: 'Envío de un cambio entregado' },
  'shipment.failed_attempt': { category: 'transactional', channels: ['webpush', 'email', 'sms'], audience: 'customer', description: 'Intento de entrega fallido' },
  'shipment.returned_to_origin': { category: 'transactional', channels: ['email'], audience: 'customer', description: 'El envío volvió a bodega' },
  'invoice.authorized': { category: 'transactional', channels: ['webpush'], audience: 'customer', description: 'Comprobante autorizado por el SRI' },
  'invoice.rejected': { category: 'transactional', channels: ['ntfy'], audience: 'staff', description: 'Comprobante devuelto o no autorizado por el SRI' },
  'ticket.created': { category: 'transactional', channels: ['email'], audience: 'customer', description: 'Soporte: recibimos tu solicitud (con el enlace al ticket)' },
  'ticket.reply': { category: 'transactional', channels: ['email'], audience: 'customer', description: 'Soporte: respuesta del agente al cliente' },
  'ticket.csat': { category: 'transactional', channels: ['email'], audience: 'customer', description: 'Soporte: ticket cerrado y encuesta de satisfacción (CSAT)' },
  'ticket.sla_breached': { category: 'transactional', channels: ['ntfy'], audience: 'staff', description: 'Soporte: SLA vencido de un ticket' },
  'cart.reminder.1h': { category: 'marketing', channels: ['email', 'whatsapp'], audience: 'customer', description: 'Carrito abandonado: recordatorio de 1 h' },
  'cart.reminder.24h': { category: 'marketing', channels: ['email', 'whatsapp'], audience: 'customer', description: 'Carrito abandonado: recordatorio de 24 h' },
  'cart.reminder.72h': { category: 'marketing', channels: ['email', 'whatsapp', 'sms'], audience: 'customer', description: 'Carrito abandonado: último recordatorio (72 h)' },
} as const satisfies Record<string, CatalogEntry>;

export type TemplateCode = keyof typeof TEMPLATE_CATALOG;

export function isTemplateCode(code: string): code is TemplateCode {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_CATALOG, code);
}

export function catalogEntry(code: TemplateCode): CatalogEntry {
  return TEMPLATE_CATALOG[code];
}

/** Estados de envío que se avisan al cliente (los demás, como 'pending' o 'cancelled', no). */
const NOTIFIED_SHIPMENT_STATUSES = ['assigned', 'picked_up', 'in_transit', 'arriving', 'delivered', 'failed_attempt', 'returned_to_origin'] as const;

/**
 * Plantilla de un cambio de estado de envío, o null si no se avisa:
 *  - Retiros de devolución ('return'): los avisan los eventos de la devolución (ReturnReceived…).
 *  - Entrega de un pedido ('outbound' → 'delivered'): la avisa OrderDelivered; se evita el doble aviso.
 *  - 'cancelled': lo avisa OrderCancelled.
 */
export function shipmentTemplate(direction: string, status: string): TemplateCode | null {
  if (direction === 'return') return null;
  if (!(NOTIFIED_SHIPMENT_STATUSES as readonly string[]).includes(status)) return null;
  if (direction === 'outbound' && status === 'delivered') return null;
  return `shipment.${status}` as TemplateCode;
}

/** Plantilla del recordatorio de carrito según la etapa ('1h' | '24h' | '72h'). */
export function cartReminderTemplate(stageLabel: string): TemplateCode | null {
  const code = `cart.reminder.${stageLabel}`;
  return isTemplateCode(code) ? code : null;
}

/** Comprobación de coherencia: marketing solo por canales con propósito de consentimiento. */
export function marketingChannelsWithoutPurpose(): string[] {
  return Object.entries(TEMPLATE_CATALOG as Record<string, CatalogEntry>)
    .filter(([, e]) => e.category === 'marketing')
    .flatMap(([code, e]) => e.channels.filter((c) => MARKETING_PURPOSE[c] === null).map((c) => `${code}:${c}`));
}
