import { DomainEvent } from '../../../shared-kernel';
import type { ElectronicDocument, SriMessage } from './electronic-document';

export const INVOICE_AUTHORIZED = 'InvoiceAuthorized';
export const INVOICE_REJECTED = 'InvoiceRejected';

const AGGREGATE_TYPE = 'billing.electronic_document';

/** Consumidores: Notificaciones, Soporte. El email con RIDE y XML ya lo envía Facturación. */
export interface InvoiceAuthorizedPayload {
  documentId: string;
  /** 01 factura, 04 nota de crédito. */
  docType: string;
  orderId: string | null;
  accessKey: string;
  authorizationNumber: string;
  authorizedAt: string;
  total: string;
  buyerEmail: string | null;
}

/** DEVUELTA (recepción) o NO AUTORIZADO (autorización): requiere revisión del backoffice. */
export interface InvoiceRejectedPayload {
  documentId: string;
  docType: string;
  orderId: string | null;
  accessKey: string;
  status: 'returned' | 'not_authorized';
  messages: SriMessage[];
}

export function invoiceAuthorized(d: ElectronicDocument): DomainEvent {
  const payload: InvoiceAuthorizedPayload = {
    documentId: d.id,
    docType: d.docType,
    orderId: d.orderId,
    accessKey: d.accessKey,
    authorizationNumber: d.authorizationNumber!,
    authorizedAt: d.authorizedAt!.toISOString(),
    total: d.total,
    buyerEmail: d.buyer.email,
  };
  return { tenantId: d.tenantId, aggregateType: AGGREGATE_TYPE, aggregateId: d.id, eventType: INVOICE_AUTHORIZED, payload: { ...payload } };
}

export function invoiceRejected(d: ElectronicDocument, status: 'returned' | 'not_authorized', messages: SriMessage[]): DomainEvent {
  const payload: InvoiceRejectedPayload = { documentId: d.id, docType: d.docType, orderId: d.orderId, accessKey: d.accessKey, status, messages };
  return { tenantId: d.tenantId, aggregateType: AGGREGATE_TYPE, aggregateId: d.id, eventType: INVOICE_REJECTED, payload: { ...payload } };
}
