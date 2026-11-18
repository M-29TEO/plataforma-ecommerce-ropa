import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../shared-kernel';
import { assertValidBuyerId } from '../domain/buyer-id';
import { assertConsumerFinalAllowed, isConsumerFinal } from '../domain/invoice';
import { CreditNoteIssueResult, CreditNoteIssuer } from './credit-note-issuer.service';
import { DocumentQueryService, DocumentView } from './document-query.service';
import { InvoiceIssuer, IssueResult } from './invoice-issuer.service';

/**
 * Fachada síncrona para otros módulos. Checkout valida al comprador ANTES de vender, para que
 * la factura no termine DEVUELTA por el SRI.
 */
@Injectable()
export class BillingApi {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly issuer: InvoiceIssuer,
    private readonly creditNotes: CreditNoteIssuer,
    private readonly queries: DocumentQueryService,
  ) {}

  /**
   * Lanza InvalidBuyerIdError (identificación que no corresponde a su tipo) o
   * BuyerIdRequiredError (consumidor final por encima de SRI_CONSUMIDOR_FINAL_MAX).
   * invoiceTotalCents es el importe de la factura: incluye lo que se pague con gift card.
   */
  assertBuyerCanBeInvoiced(buyer: { idType?: string | null; idNumber?: string | null }, invoiceTotalCents: number): void {
    if (isConsumerFinal(buyer.idType, buyer.idNumber)) {
      assertConsumerFinalAllowed(invoiceTotalCents, this.config.billing.consumerFinalMaxCents);
      return;
    }
    assertValidBuyerId(buyer.idType!, buyer.idNumber!.trim());
  }

  /** Lo usa el consumidor de OrderPaid; público para herramientas de soporte y tests. */
  issueForOrder(tenantId: string, orderId: string): Promise<IssueResult> {
    return this.issuer.issueForOrder(tenantId, orderId);
  }

  listForOrder(tenantId: string, orderId: string): Promise<DocumentView[]> {
    return this.queries.list(tenantId, { orderId, limit: 20, offset: 0 });
  }

  /** Lo usa el consumidor de RefundSucceeded; público para soporte y tests. */
  issueCreditNoteForReturn(tenantId: string, returnId: string): Promise<CreditNoteIssueResult> {
    return this.creditNotes.issueForReturn(tenantId, returnId);
  }

  /** Nota de crédito de una devolución (la más reciente, en cualquier estado), o null. */
  async findCreditNoteForReturn(tenantId: string, returnId: string): Promise<DocumentView | null> {
    const [doc] = await this.queries.list(tenantId, { returnId, docType: '04', limit: 1, offset: 0 });
    return doc ?? null;
  }
}
