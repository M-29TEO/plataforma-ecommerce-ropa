import { fromCents, toCents, ValidationError } from '../../../shared-kernel';
import type { CartView } from '../../cart';
import type { CustomerSnapshot } from '../../orders';
import type { PaymentCreated } from '../../payments';
import type { CheckoutPaymentMethod } from './checkout';

/**
 * Pedidos asistidos: un vendedor del backoffice arma el pedido a nombre de un cliente (por
 * teléfono, WhatsApp o en tienda). Reglas puras; la orquestación está en AssistedOrderService.
 */

/**
 * Cómo paga el cliente un pedido asistido:
 *  - transfer: transfiere y sube el comprobante con el enlace del pago;
 *  - cod: paga al recibir (contra entrega);
 *  - card_link: el vendedor le envía el enlace de la pasarela (pago con tarjeta).
 */
export const ASSISTED_PAYMENT_METHODS = ['transfer', 'cod', 'card_link'] as const;
export type AssistedPaymentMethod = (typeof ASSISTED_PAYMENT_METHODS)[number];

/** Método que se registra en Pagos y Pedidos. */
export function gatewayMethod(method: AssistedPaymentMethod): CheckoutPaymentMethod {
  return method === 'card_link' ? 'card' : method;
}

/**
 * Plazo del pago de un pedido asistido, en segundos (null: el del método, cod no vence).
 *  - card_link: ASSISTED_PAYMENT_LINK_TTL_MINUTES (24 h por defecto), no los 15 min del checkout
 *    web: el cliente recibe el enlace por WhatsApp y puede abrirlo horas después.
 *  - transfer: el mayor entre ese plazo y PAYMENT_TRANSFER_TTL_HOURS (12 h por defecto). El plazo
 *    cubre transferir, enviar el comprobante y que el backoffice lo verifique; un pedido tomado de
 *    noche vencería antes de que abra el banco o de que alguien lo revise.
 */
export function assistedPaymentTtlSeconds(
  method: AssistedPaymentMethod,
  config: { assistedLinkTtlMinutes: number; transferTtlHours: number },
): number | null {
  const link = config.assistedLinkTtlMinutes * 60;
  if (method === 'card_link') return link;
  if (method === 'transfer') return Math.max(link, config.transferTtlHours * 3600);
  return null;
}

/** Cliente registrado tal como lo devuelve IAM. */
export interface RegisteredCustomer {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  idType: string | null;
  idNumber: string | null;
  status: 'pending' | 'active' | 'blocked';
}

export interface GuestCustomer {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  idType?: string;
  idNumber?: string;
}

export class AssistedOrderError extends ValidationError {}

/** Nombre visible: "Nombre Apellido", o el email si la cuenta no tiene nombre. */
export function displayName(firstName: string | null | undefined, lastName: string | null | undefined, email: string): string {
  const name = [firstName, lastName].map((s) => s?.trim()).filter(Boolean).join(' ');
  return name || email;
}

/**
 * Snapshot del cliente para el pedido. Un cliente bloqueado no compra (422 CUSTOMER_BLOCKED).
 * La identificación solo se copia si viene completa (tipo y número): Facturación la valida.
 */
export function customerSnapshot(c: RegisteredCustomer | GuestCustomer): CustomerSnapshot {
  if ('status' in c && c.status === 'blocked') {
    throw new AssistedOrderError('CUSTOMER_BLOCKED', 'La cuenta del cliente está bloqueada');
  }
  const snapshot: CustomerSnapshot = { name: displayName(c.firstName, c.lastName, c.email), email: c.email.trim().toLowerCase() };
  if (c.phone) snapshot.phone = c.phone;
  if (c.idType && c.idNumber) {
    snapshot.idType = c.idType;
    snapshot.idNumber = c.idNumber;
  }
  return snapshot;
}

/** Totales que ve el vendedor: mercadería con descuentos e IVA, más el envío (ya con su descuento). */
export interface AssistedTotals {
  subtotal: string;
  discountTotal: string;
  shippingTotal: string;
  taxTotal: string;
  total: string;
}

/**
 * Totales a partir del borrador valorizado con el envío cotizado (`shippingQuoted`, antes de
 * promociones de envío gratis). Misma cuenta que el checkout: total = mercadería + envío − descuento de envío.
 */
export function assistedTotals(cart: CartView, shippingQuoted: string): AssistedTotals {
  const shippingCents = Math.max(0, toCents(shippingQuoted) - toCents(cart.shippingDiscount));
  return {
    subtotal: cart.totals.subtotal,
    discountTotal: cart.totals.discountTotal,
    shippingTotal: fromCents(shippingCents),
    taxTotal: cart.totals.taxTotal,
    total: fromCents(toCents(cart.totals.total) + shippingCents),
  };
}

/** Lo que el vendedor necesita del pago para enviárselo al cliente. */
export interface AssistedPaymentView {
  id: string;
  method: AssistedPaymentMethod;
  status: string;
  amount: string;
  expiresAt: Date | null;
  /** card_link: URL de la pasarela (simulada) para enviar al cliente. */
  paymentUrl?: string;
  /**
   * Secreto del pago (header X-Payment-Secret): con él, el cliente consulta el estado
   * (GET /v1/payments/:id/public) y sube el comprobante de la transferencia.
   */
  clientSecret: string;
  /** transfer: datos de la cuenta, referencia y dónde se sube el comprobante. */
  transfer?: { account: string; reference: string; expiresAt: string | null; voucherUploadPath: string };
}

export function assistedPaymentView(method: AssistedPaymentMethod, created: PaymentCreated): AssistedPaymentView {
  const { payment, clientSecret, nextAction } = created;
  const view: AssistedPaymentView = {
    id: payment.id,
    method,
    status: payment.status,
    amount: payment.amount,
    expiresAt: payment.expiresAt,
    clientSecret,
  };
  if (nextAction.type === 'redirect') view.paymentUrl = nextAction.url;
  if (nextAction.type === 'bank_transfer') {
    view.transfer = {
      account: nextAction.account,
      reference: nextAction.reference,
      expiresAt: nextAction.expiresAt,
      voucherUploadPath: `/v1/payments/${payment.id}/transfer/voucher`,
    };
  }
  return view;
}
