import { randomInt } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database } from '../../../shared-kernel';
import { OrdersApi, ReturnDetail } from '../../orders';
import { buildAccessKey } from '../domain/access-key';
import { CreditNoteSource, draftCreditNote } from '../domain/credit-note';
import { DOC_TYPE_CREDIT_NOTE } from '../domain/credit-note-xml';
import { ecuadorDate } from '../domain/dates';
import { CreditNoteNotAllowedError, EmissionPointNotConfiguredError, InvoiceToModifyNotFoundError } from '../domain/errors';
import { IssueResult } from './invoice-issuer.service';
import { DocumentRepository } from './ports';

/** Señal interna: otro proceso emitió la nota de crédito de la misma devolución. */
class AlreadyIssued extends Error {}

export type CreditNoteIssueResult = IssueResult | { documentId: null; created: false; skipped: 'consumer_final' };

/** Devolución (API pública de Pedidos) → lo que la nota de crédito necesita. */
export function creditNoteSourceFrom(r: ReturnDetail): CreditNoteSource {
  if (r.refundAmount === null) throw new Error(`La devolución ${r.id} no tiene monto reembolsado`);
  return {
    returnId: r.id,
    rmaNumber: r.rmaNumber,
    orderNumber: r.order.orderNumber,
    reason: r.reason,
    refundAmount: r.refundAmount,
    lines: r.lines.map((l) => ({
      sku: l.sku,
      productName: l.productName,
      colorName: l.colorName,
      sizeCode: l.sizeCode,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount,
      taxCode: l.taxCode,
      taxBase: l.taxBase,
      taxAmount: l.taxAmount,
      total: l.total,
    })),
  };
}

/**
 * Emisión de la nota de crédito (tipo 04) de una devolución reembolsada (consumidor de
 * RefundSucceeded). Igual que la factura: corre en la transacción del relay, toma el secuencial de
 * notas de crédito del punto de emisión, arma la clave de acceso y guarda el documento con sus
 * líneas vinculado a la factura original (modified_document_id) y a la devolución (return_id). La
 * firma, el envío al SRI, el RIDE y el email los hace el job; el job espera a que la factura esté
 * autorizada antes de enviar la nota de crédito.
 */
@Injectable()
export class CreditNoteIssuer {
  private readonly logger = new Logger(CreditNoteIssuer.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Database,
    private readonly documents: DocumentRepository,
    private readonly orders: OrdersApi,
  ) {}

  /** Idempotente: una devolución tiene una sola nota de crédito vigente (ux_ed_return_credit_note). */
  async issueForReturn(tenantId: string, returnId: string, now = new Date()): Promise<CreditNoteIssueResult> {
    return this.db.withTransaction(async (tx) => {
      const existing = await this.documents.findCreditNoteByReturn(tx, tenantId, returnId);
      if (existing) return { documentId: existing.id, created: false };

      const ret = await this.orders.getReturn(tenantId, returnId);
      const invoice = await this.documents.findCurrentInvoice(tx, tenantId, ret.orderId);
      // Sin factura todavía (el relay reintenta el evento) o anulada: no hay qué modificar.
      if (!invoice) throw new InvoiceToModifyNotFoundError(ret.orderId);
      let draft;
      try {
        draft = draftCreditNote(creditNoteSourceFrom(ret), {
          buyer: invoice.buyer,
          total: invoice.total,
          creditedBefore: await this.documents.creditedTotal(tx, invoice.id),
        });
      } catch (error) {
        if (!(error instanceof CreditNoteNotAllowedError)) throw error;
        this.logger.warn(`Devolución ${ret.rmaNumber}: la factura es a consumidor final, no se emite nota de crédito`);
        return { documentId: null, created: false, skipped: 'consumer_final' };
      }

      const { establishment, emissionPoint, emitter } = this.config.billing;
      const point = await this.documents.findEmissionPoint(tx, tenantId, establishment, emissionPoint);
      if (!point) throw new EmissionPointNotConfiguredError(tenantId, establishment, emissionPoint);
      try {
        // Savepoint: si otro proceso ya la emitió, se revierte también el incremento del secuencial.
        return await this.db.withTransaction(async (sp) => {
          const sequential = await this.documents.nextSequential(sp, point.id, DOC_TYPE_CREDIT_NOTE);
          if (sequential === null) throw new EmissionPointNotConfiguredError(tenantId, establishment, emissionPoint);
          const issueDate = ecuadorDate(now);
          const accessKey = buildAccessKey({
            issueDate,
            docType: DOC_TYPE_CREDIT_NOTE,
            ruc: emitter.ruc,
            environment: point.environment,
            establishment,
            emissionPoint,
            sequential,
            numericCode: String(randomInt(0, 100_000_000)).padStart(8, '0'),
            emissionType: '1',
          });
          const id = await this.documents.insert(
            sp,
            {
              tenantId,
              docType: DOC_TYPE_CREDIT_NOTE,
              emissionPointId: point.id,
              sequential,
              accessKey,
              environment: point.environment,
              issueDate,
              orderId: ret.orderId,
              returnId,
              modifiedDocumentId: invoice.id,
              buyer: draft.buyer,
              subtotal0: draft.subtotal0,
              subtotalTaxed: draft.subtotalTaxed,
              discountTotal: draft.discountTotal,
              taxTotal: draft.taxTotal,
              total: draft.total,
              paymentForms: [],
              nextRetryAt: now,
            },
            draft.lines,
          );
          if (!id) throw new AlreadyIssued();
          return { documentId: id, created: true };
        });
      } catch (error) {
        if (!(error instanceof AlreadyIssued)) throw error;
        const winner = await this.documents.findCreditNoteByReturn(tx, tenantId, returnId);
        if (!winner) throw error;
        return { documentId: winner.id, created: false };
      }
    });
  }
}
