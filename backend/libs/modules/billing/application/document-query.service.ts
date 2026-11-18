import { Injectable } from '@nestjs/common';
import { Database, StoredObject } from '../../../shared-kernel';
import { OrderNotFoundError, OrdersApi } from '../../orders';
import { DocumentStatus, ElectronicDocument, SriMessage } from '../domain/electronic-document';
import { DocumentFileNotReadyError, DocumentNotFoundError } from '../domain/errors';
import { InvoiceLine, PaymentForm } from '../domain/invoice';
import { DOC_TYPE_INVOICE, formatSequential } from '../domain/invoice-xml';
import { DocumentFilter, DocumentRepository, DocumentStorage } from './ports';

export interface DocumentView {
  id: string;
  docType: string;
  /** 001-001-000000123 */
  number: string;
  accessKey: string;
  environment: 1 | 2;
  issueDate: string;
  orderId: string | null;
  /** Nota de crédito: devolución que la origina y factura que modifica. */
  returnId: string | null;
  modifiedDocumentId: string | null;
  status: DocumentStatus;
  buyer: ElectronicDocument['buyer'];
  totals: { subtotal0: string; subtotalTaxed: string; discountTotal: string; taxTotal: string; total: string };
  paymentForms: PaymentForm[];
  authorizationNumber: string | null;
  authorizedAt: Date | null;
  sriMessages: SriMessage[];
  attempts: number;
  nextRetryAt: Date | null;
  emailedAt: Date | null;
  files: { xml: boolean; ride: boolean };
  createdAt: Date;
  lines?: InvoiceLine[];
}

function view(d: ElectronicDocument & { lines?: InvoiceLine[] }): DocumentView {
  return {
    id: d.id,
    docType: d.docType,
    number: `${d.establishment}-${d.emissionPoint}-${formatSequential(d.sequential)}`,
    accessKey: d.accessKey,
    environment: d.environment,
    issueDate: d.issueDate,
    orderId: d.orderId,
    returnId: d.returnId,
    modifiedDocumentId: d.modifiedDocumentId,
    status: d.status,
    buyer: d.buyer,
    totals: { subtotal0: d.subtotal0, subtotalTaxed: d.subtotalTaxed, discountTotal: d.discountTotal, taxTotal: d.taxTotal, total: d.total },
    paymentForms: d.paymentForms,
    authorizationNumber: d.authorizationNumber,
    authorizedAt: d.authorizedAt,
    sriMessages: d.sriMessages,
    attempts: d.attempts,
    nextRetryAt: d.nextRetryAt,
    emailedAt: d.emailedAt,
    files: { xml: !!d.xmlKey, ride: !!d.rideKey },
    createdAt: d.createdAt,
    ...(d.lines ? { lines: d.lines } : {}),
  };
}

export type DocumentFile = StoredObject & { filename: string };

/** Consultas del backoffice y del cliente (su propia factura). */
@Injectable()
export class DocumentQueryService {
  constructor(
    private readonly db: Database,
    private readonly documents: DocumentRepository,
    private readonly storage: DocumentStorage,
    private readonly orders: OrdersApi,
  ) {}

  async list(tenantId: string, filter: DocumentFilter): Promise<DocumentView[]> {
    return (await this.documents.list(this.db, tenantId, filter)).map(view);
  }

  async get(tenantId: string, id: string): Promise<DocumentView> {
    const d = await this.documents.findById(this.db, tenantId, id);
    if (!d) throw new DocumentNotFoundError(id);
    return view(d);
  }

  /** XML (autorizado si ya lo está; si no, el firmado) o RIDE en PDF. */
  async file(tenantId: string, id: string, kind: 'xml' | 'ride'): Promise<DocumentFile> {
    const d = await this.documents.findById(this.db, tenantId, id);
    if (!d) throw new DocumentNotFoundError(id);
    const key = kind === 'xml' ? d.xmlKey : d.rideKey;
    if (!key) throw new DocumentFileNotReadyError(id, kind);
    const stored = await this.storage.get(key);
    if (!stored) throw new DocumentFileNotReadyError(id, kind);
    const number = `${d.establishment}-${d.emissionPoint}-${formatSequential(d.sequential)}`;
    const prefix = d.docType === '04' ? 'nota-credito' : 'factura';
    return { ...stored, filename: `${prefix}-${number}.${kind === 'xml' ? 'xml' : 'pdf'}` };
  }

  /** Factura del pedido de un cliente. Un pedido ajeno o sin factura responde 404. */
  async forCustomerOrder(tenantId: string, userId: string, orderId: string): Promise<DocumentView> {
    return view(await this.customerDocument(tenantId, userId, orderId));
  }

  /** Solo archivos de facturas autorizadas: el cliente no ve comprobantes en trámite. */
  async customerFile(tenantId: string, userId: string, orderId: string, kind: 'xml' | 'ride'): Promise<DocumentFile> {
    const d = await this.customerDocument(tenantId, userId, orderId);
    if (d.status !== 'authorized') throw new DocumentFileNotReadyError(d.id, kind);
    return this.file(tenantId, d.id, kind);
  }

  private async customerDocument(tenantId: string, userId: string, orderId: string): Promise<ElectronicDocument> {
    try {
      const order = await this.orders.getOrder(tenantId, orderId);
      if (order.userId !== userId) throw new DocumentNotFoundError(orderId);
    } catch (error) {
      if (error instanceof OrderNotFoundError) throw new DocumentNotFoundError(orderId);
      throw error;
    }
    const d = await this.documents.findByOrder(this.db, tenantId, orderId, DOC_TYPE_INVOICE);
    if (!d) throw new DocumentNotFoundError(orderId);
    return d;
  }
}
