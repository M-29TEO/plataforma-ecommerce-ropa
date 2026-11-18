import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database } from '../../../shared-kernel';
import { OrdersApi } from '../../orders';
import { buildAccessKey } from '../domain/access-key';
import { ecuadorDate } from '../domain/dates';
import { EmissionPointNotConfiguredError } from '../domain/errors';
import { draftInvoice } from '../domain/invoice';
import { DOC_TYPE_INVOICE } from '../domain/invoice-xml';
import { invoiceSourceFrom } from './invoice-source';
import { DocumentRepository } from './ports';

/** Señal interna: otro proceso facturó el mismo pedido entre la consulta y el INSERT. */
class AlreadyInvoiced extends Error {}

export interface IssueResult {
  documentId: string;
  created: boolean;
}

/**
 * Emisión de la factura de un pedido pagado (consumidor de OrderPaid; en contra entrega, Pedidos
 * emite OrderPaid al entregar). Corre dentro de la transacción del relay del outbox: el secuencial
 * (UPDATE ... RETURNING), la clave de acceso y el documento con sus líneas se confirman juntos con
 * la marca de evento publicado. Aquí no hay I/O externo: firmar, enviar al SRI, guardar y enviar
 * el email lo hace el job (DocumentProcessor), que reintenta con backoff.
 */
@Injectable()
export class InvoiceIssuer {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Database,
    private readonly documents: DocumentRepository,
    private readonly orders: OrdersApi,
  ) {}

  /** Idempotente: un pedido tiene una sola factura (ux_ed_order_invoice). */
  async issueForOrder(tenantId: string, orderId: string, now = new Date()): Promise<IssueResult> {
    return this.db.withTransaction(async (tx) => {
      const existing = await this.documents.findByOrder(tx, tenantId, orderId, DOC_TYPE_INVOICE);
      if (existing) return { documentId: existing.id, created: false };

      const draft = draftInvoice(invoiceSourceFrom(await this.orders.getOrder(tenantId, orderId)));
      const { establishment, emissionPoint, emitter } = this.config.billing;
      const point = await this.documents.findEmissionPoint(tx, tenantId, establishment, emissionPoint);
      if (!point) throw new EmissionPointNotConfiguredError(tenantId, establishment, emissionPoint);

      try {
        // Savepoint: si el INSERT choca con la factura que otro proceso acaba de confirmar, se
        // revierte también el incremento del secuencial (no quedan huecos).
        return await this.db.withTransaction(async (sp) => {
          const sequential = await this.documents.nextSequential(sp, point.id, DOC_TYPE_INVOICE);
          if (sequential === null) throw new EmissionPointNotConfiguredError(tenantId, establishment, emissionPoint);
          const issueDate = ecuadorDate(now);
          const accessKey = buildAccessKey({
            issueDate,
            docType: DOC_TYPE_INVOICE,
            ruc: emitter.ruc,
            environment: point.environment,
            establishment,
            emissionPoint,
            sequential,
            numericCode: String(randomInt(0, 100_000_000)).padStart(8, '0'),
            emissionType: '1',
          });
          const { phone: _phone, ...buyer } = draft.buyer;
          const id = await this.documents.insert(
            sp,
            {
              tenantId,
              docType: DOC_TYPE_INVOICE,
              emissionPointId: point.id,
              sequential,
              accessKey,
              environment: point.environment,
              issueDate,
              orderId,
              buyer,
              subtotal0: draft.subtotal0,
              subtotalTaxed: draft.subtotalTaxed,
              discountTotal: draft.discountTotal,
              taxTotal: draft.taxTotal,
              total: draft.total,
              paymentForms: draft.paymentForms,
              nextRetryAt: now,
            },
            draft.lines,
          );
          if (!id) throw new AlreadyInvoiced();
          return { documentId: id, created: true };
        });
      } catch (error) {
        if (!(error instanceof AlreadyInvoiced)) throw error;
        const winner = await this.documents.findByOrder(tx, tenantId, orderId, DOC_TYPE_INVOICE);
        if (!winner) throw error;
        return { documentId: winner.id, created: false };
      }
    });
  }
}
