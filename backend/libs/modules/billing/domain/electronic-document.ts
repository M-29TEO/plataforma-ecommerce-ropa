import { InvoiceBuyer, InvoiceLine, PaymentForm } from './invoice';

/**
 * Ciclo de vida de un comprobante (columna status de billing.electronic_documents):
 *
 *   pending ──firma──▶ signed ──envío──▶ received ──consulta──▶ authorized
 *                        │  ▲               │
 *                        ▼  │ reintento     └──▶ not_authorized (firma inválida, totales...)
 *                       sent
 *                        │
 *                        └──▶ returned (DEVUELTA: el XML no cumple la ficha técnica)
 *
 * sent = se envió pero no hubo respuesta (timeout, conexión cortada): se reenvía, y si el SRI ya
 * lo tenía responde "CLAVE ACCESO REGISTRADA" (43), que se trata como recibido.
 * voided queda para la anulación (fuera de este módulo por ahora).
 */
export const DOCUMENT_STATUSES = ['pending', 'signed', 'sent', 'received', 'authorized', 'returned', 'not_authorized', 'voided'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Estados en los que el job todavía tiene trabajo con el SRI. */
export const IN_PROGRESS: readonly DocumentStatus[] = ['pending', 'signed', 'sent', 'received'];

export interface SriMessage {
  identificador: string;
  mensaje: string;
  informacionAdicional: string | null;
  tipo: string;
}

export interface ElectronicDocument {
  id: string;
  tenantId: string;
  docType: string;
  emissionPointId: string;
  establishment: string;
  emissionPoint: string;
  establishmentAddress: string;
  sequential: number;
  accessKey: string;
  environment: 1 | 2;
  issueDate: string;
  orderId: string | null;
  /** Nota de crédito: la devolución que la origina y la factura que modifica. */
  returnId: string | null;
  modifiedDocumentId: string | null;
  buyer: Omit<InvoiceBuyer, 'phone'>;
  subtotal0: string;
  subtotalTaxed: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  paymentForms: PaymentForm[];
  status: DocumentStatus;
  authorizationNumber: string | null;
  authorizedAt: Date | null;
  xmlKey: string | null;
  rideKey: string | null;
  sriMessages: SriMessage[];
  attempts: number;
  nextRetryAt: Date | null;
  emailedAt: Date | null;
  createdAt: Date;
}

export type ElectronicDocumentWithLines = ElectronicDocument & { lines: InvoiceLine[] };

/** Espera antes del siguiente intento: base × 2^(intentos − 1), con tope (30 s, 60 s, 2 min... 1 h). */
export function backoffSeconds(attempts: number, baseSeconds: number, maxSeconds: number): number {
  const exp = Math.max(0, attempts - 1);
  return Math.min(maxSeconds, baseSeconds * 2 ** Math.min(exp, 30));
}

/** Intentos de envío de email antes de dejarlo para reenvío manual. */
export const MAX_EMAIL_ATTEMPTS = 8;

/** Carpeta del comprobante en el almacenamiento: billing/<tenant>/<aaaa>/<mm>/<clave>/ */
export function storagePrefix(doc: Pick<ElectronicDocument, 'tenantId' | 'issueDate' | 'accessKey'>): string {
  const [y, m] = doc.issueDate.split('-');
  return `billing/${doc.tenantId}/${y}/${m}/${doc.accessKey}`;
}
