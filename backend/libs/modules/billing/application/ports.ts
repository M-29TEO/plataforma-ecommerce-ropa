/**
 * Puertos del módulo Facturación: persistencia (schema billing) y servicios externos (SRI,
 * almacenamiento de XML/RIDE, email) más la firma y el RIDE, que dependen de criptografía y PDF.
 */
import { ObjectStorage, Queryable } from '../../../shared-kernel';
import type { DocumentStatus, ElectronicDocument, ElectronicDocumentWithLines, SriMessage } from '../domain/electronic-document';
import type { InvoiceBuyer, InvoiceLine, PaymentForm } from '../domain/invoice';
import type { CreditNoteData } from '../domain/credit-note-xml';
import type { InvoiceData } from '../domain/invoice-xml';

export interface EmissionPoint {
  id: string;
  environment: 1 | 2;
  address: string;
}

export interface NewDocument {
  tenantId: string;
  docType: string;
  emissionPointId: string;
  sequential: number;
  accessKey: string;
  environment: 1 | 2;
  issueDate: string;
  orderId: string;
  returnId?: string | null;
  modifiedDocumentId?: string | null;
  buyer: Omit<InvoiceBuyer, 'phone'>;
  subtotal0: string;
  subtotalTaxed: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  paymentForms: PaymentForm[];
  nextRetryAt: Date;
}

export interface DocumentPatch {
  status?: DocumentStatus;
  authorizationNumber?: string | null;
  authorizedAt?: Date | null;
  xmlKey?: string | null;
  rideKey?: string | null;
  sriMessages?: SriMessage[];
  attempts?: number;
  nextRetryAt?: Date | null;
  emailedAt?: Date | null;
}

export interface DocumentFilter {
  orderId?: string;
  returnId?: string;
  docType?: string;
  statuses?: DocumentStatus[];
  limit: number;
  offset: number;
}

export abstract class DocumentRepository {
  abstract findEmissionPoint(q: Queryable, tenantId: string, establishment: string, emissionPoint: string): Promise<EmissionPoint | null>;
  /**
   * UPDATE billing.sequences SET last_value = last_value + 1 ... RETURNING last_value (patrón 3 de
   * docs/03). Bloquea la fila hasta el COMMIT: los secuenciales salen en orden y sin huecos (si la
   * transacción se revierte, el incremento también). null si no hay fila para ese punto y tipo.
   */
  abstract nextSequential(q: Queryable, emissionPointId: string, docType: string): Promise<number | null>;
  /**
   * null si el pedido ya tiene factura (ux_ed_order_invoice) o la devolución ya tiene nota de
   * crédito (ux_ed_return_credit_note).
   */
  abstract insert(q: Queryable, doc: NewDocument, lines: InvoiceLine[]): Promise<string | null>;
  /** Factura vigente del pedido (ni anulada ni NO AUTORIZADA), la más reciente. */
  abstract findCurrentInvoice(q: Queryable, tenantId: string, orderId: string): Promise<ElectronicDocument | null>;
  /** Nota de crédito vigente de la devolución. */
  abstract findCreditNoteByReturn(q: Queryable, tenantId: string, returnId: string): Promise<ElectronicDocument | null>;
  /** Suma de las notas de crédito vigentes que modifican una factura. */
  abstract creditedTotal(q: Queryable, invoiceId: string): Promise<string>;
  abstract findByOrder(q: Queryable, tenantId: string, orderId: string, docType: string): Promise<ElectronicDocument | null>;
  abstract findById(q: Queryable, tenantId: string, id: string): Promise<ElectronicDocumentWithLines | null>;
  abstract list(q: Queryable, tenantId: string, filter: DocumentFilter): Promise<ElectronicDocument[]>;
  /**
   * Toma hasta `limit` comprobantes con trabajo vencido (next_retry_at <= now) con SKIP LOCKED y
   * les corre next_retry_at `leaseSeconds` hacia adelante: mientras un worker habla con el SRI
   * (fuera de la transacción), otro no toma el mismo comprobante. tenantId limita la pasada a un
   * tenant (tests que comparten la base).
   */
  abstract claimDue(q: Queryable, now: Date, leaseSeconds: number, limit: number, tenantId?: string | null): Promise<ElectronicDocumentWithLines[]>;
  /** Estado e intentos actuales (para reprogramar tras una falla). */
  abstract findState(q: Queryable, id: string): Promise<{ status: DocumentStatus; attempts: number } | null>;
  /** UPDATE condicionado al estado leído: false si otro proceso ya lo cambió. */
  abstract update(q: Queryable, id: string, expectedStatus: DocumentStatus, patch: DocumentPatch): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------
// SRI (web services offline: recepción y autorización)
// ---------------------------------------------------------------------------------------

export type ReceptionResult = { status: 'RECIBIDA'; messages: SriMessage[] } | { status: 'DEVUELTA'; messages: SriMessage[] };

export type AuthorizationResult =
  | { status: 'AUTORIZADO'; authorizationNumber: string; authorizedAt: Date; environment: string; comprobante: string; messages: SriMessage[] }
  | { status: 'NO AUTORIZADO'; messages: SriMessage[] }
  /** Todavía no hay respuesta (el SRI procesa en lote). */
  | { status: 'EN PROCESO' };

/** Falla transitoria (red, timeout, 5xx): se reintenta con backoff. */
export class SriUnavailableError extends Error {
  constructor(
    message: string,
    /** true si la petición pudo llegar al SRI (timeout esperando la respuesta). */
    readonly maybeDelivered: boolean,
  ) {
    super(message);
    this.name = 'SriUnavailableError';
  }
}

export abstract class SriPort {
  /** validarComprobante: XML firmado. */
  abstract send(signedXml: string): Promise<ReceptionResult>;
  /** autorizacionComprobante: por clave de acceso. */
  abstract authorize(accessKey: string): Promise<AuthorizationResult>;
}

// ---------------------------------------------------------------------------------------
// Firma, RIDE, almacenamiento y email
// ---------------------------------------------------------------------------------------

export abstract class InvoiceSigner {
  /** XML canónico sin firma → XML con ds:Signature (XAdES-BES), sin declaración. */
  abstract sign(xml: string, now: Date): string;
}

export interface RideAuthorization {
  authorizationNumber: string;
  authorizedAt: Date;
}

/** Datos del RIDE: factura (docType ausente o '01') o nota de crédito ('04'). */
export type RideData = RideAuthorization & ((InvoiceData & { docType?: '01' }) | (CreditNoteData & { docType: '04' }));

export abstract class RideRenderer {
  abstract render(data: RideData): Buffer;
}

/** Token de inyección de Facturación para el ObjectStorage compartido (claves billing/...). */
export abstract class DocumentStorage extends ObjectStorage {}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: MailAttachment[];
}

export abstract class InvoiceMailer {
  abstract send(message: MailMessage): Promise<void>;
}
