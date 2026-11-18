import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, DomainEvent, OutboxWriter } from '../../../shared-kernel';
import { OrdersApi } from '../../orders';
import {
  backoffSeconds,
  ElectronicDocumentWithLines,
  MAX_EMAIL_ATTEMPTS,
  SriMessage,
  storagePrefix,
} from '../domain/electronic-document';
import { ecuadorDateTime } from '../domain/dates';
import { invoiceAuthorized, invoiceRejected } from '../domain/events';
import { creditNoteAdditionalInfo, creditNoteReason } from '../domain/credit-note';
import { buildCreditNoteXml, CreditNoteData, DOC_TYPE_CREDIT_NOTE, documentNumber } from '../domain/credit-note-xml';
import { draftInvoice } from '../domain/invoice';
import { buildInvoiceXml, DOC_TYPE_INVOICE, formatSequential, InvoiceData, XML_DECLARATION } from '../domain/invoice-xml';
import { invoiceSourceFrom } from './invoice-source';
import {
  DocumentPatch,
  DocumentRepository,
  DocumentStorage,
  InvoiceMailer,
  InvoiceSigner,
  RideAuthorization,
  RideData,
  RideRenderer,
  SriPort,
  SriUnavailableError,
} from './ports';

/** Mientras un worker habla con el SRI, el comprobante queda "prestado" este tiempo. */
const LEASE_SECONDS = 120;
/**
 * DEVUELTA con estos códigos = el SRI ya tenía la clave (reenvío tras un timeout): está recibido.
 * 43 CLAVE ACCESO REGISTRADA · 70 CLAVE DE ACCESO EN PROCESAMIENTO.
 */
const ALREADY_REGISTERED = new Set(['43', '70']);

const XML = 'application/xml';
const PDF = 'application/pdf';

/**
 * Procesa los comprobantes pendientes (facturas 01 y notas de crédito 04), paso a paso, con estado
 * persistido entre pasos:
 *   pending  → arma el XML (factura 2.1.0 / nota de crédito 1.1.0), lo firma (XAdES-BES) y lo guarda
 *              en SeaweedFS → signed. Una nota de crédito espera a que su factura esté autorizada.
 *   signed / sent → validarComprobante: RECIBIDA → received | DEVUELTA → returned
 *   received → autorizacionComprobante: AUTORIZADO → genera el RIDE, guarda XML autorizado y
 *              RIDE → authorized | NO AUTORIZADO → not_authorized | EN PROCESO → reintenta
 *   authorized sin email → envía RIDE + XML al comprador
 *
 * Cada paso con el SRI ocurre FUERA de una transacción; el resultado se guarda con un UPDATE
 * condicionado al estado leído (y los eventos InvoiceAuthorized / InvoiceRejected en el outbox,
 * en la misma transacción). Una falla transitoria suma un intento y reprograma next_retry_at con
 * backoff exponencial (30 s, 1 min, 2 min... hasta 1 h); los pasos son idempotentes.
 */
@Injectable()
export class DocumentProcessor {
  private readonly logger = new Logger(DocumentProcessor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Database,
    private readonly documents: DocumentRepository,
    private readonly orders: OrdersApi,
    private readonly sri: SriPort,
    private readonly signer: InvoiceSigner,
    private readonly rides: RideRenderer,
    private readonly storage: DocumentStorage,
    private readonly mailer: InvoiceMailer,
    private readonly outbox: OutboxWriter,
  ) {}

  /** Una pasada del job. Devuelve cuántos comprobantes tomó. tenantId limita la pasada (tests que comparten la base). */
  async processDue(now = new Date(), limit = 20, tenantId?: string): Promise<number> {
    const due = await this.db.withTransaction((tx) => this.documents.claimDue(tx, now, LEASE_SECONDS, limit, tenantId ?? null));
    for (const doc of due) {
      try {
        await this.advance(doc, now);
      } catch (error) {
        await this.retryLater(doc, error, now);
      }
    }
    return due.length;
  }

  private async advance(doc: ElectronicDocumentWithLines, now: Date): Promise<void> {
    let signedXml: string | null = null;
    for (;;) {
      switch (doc.status) {
        case 'pending': {
          // Una nota de crédito se envía cuando el SRI ya autorizó la factura que modifica.
          if (doc.docType === DOC_TYPE_CREDIT_NOTE && !(await this.modifiedDocumentAuthorized(doc, now))) return;
          signedXml = this.signer.sign(await this.buildXml(doc), now);
          const xmlKey = `${storagePrefix(doc)}/firmado.xml`;
          await this.storage.put(xmlKey, Buffer.from(XML_DECLARATION + signedXml, 'utf8'), XML);
          if (!(await this.save(doc, { status: 'signed', xmlKey, attempts: 0 }))) return;
          doc = { ...doc, status: 'signed', xmlKey, attempts: 0 };
          break;
        }

        case 'signed':
        case 'sent': {
          signedXml ??= await this.readSignedXml(doc);
          const reception = await this.sri.send(signedXml);
          const registered = reception.messages.some((m) => ALREADY_REGISTERED.has(m.identificador));
          if (reception.status === 'DEVUELTA' && !registered) {
            await this.reject(doc, 'returned', reception.messages);
            return;
          }
          const nextRetryAt = this.after(now, this.config.billing.authPollSeconds);
          await this.save(doc, { status: 'received', sriMessages: reception.messages, attempts: 0, nextRetryAt });
          return; // el SRI autoriza en lote: se consulta en la próxima pasada
        }

        case 'received': {
          const auth = await this.sri.authorize(doc.accessKey);
          if (auth.status === 'EN PROCESO') {
            const attempts = doc.attempts + 1;
            const wait = backoffSeconds(attempts, this.config.billing.authPollSeconds, this.config.billing.retryMaxSeconds);
            await this.save(doc, { attempts, nextRetryAt: this.after(now, wait) });
            return;
          }
          if (auth.status === 'NO AUTORIZADO') {
            await this.reject(doc, 'not_authorized', auth.messages);
            return;
          }
          const prefix = storagePrefix(doc);
          const comprobante = auth.comprobante || (signedXml ?? (await this.readSignedXml(doc)));
          const authorizedXml = authorizationFile(auth.authorizationNumber, auth.authorizedAt, auth.environment, comprobante);
          const ride = this.rides.render(await this.rideData(doc, { authorizationNumber: auth.authorizationNumber, authorizedAt: auth.authorizedAt }));
          const xmlKey = `${prefix}/autorizado.xml`;
          const rideKey = `${prefix}/ride.pdf`;
          await this.storage.put(xmlKey, Buffer.from(authorizedXml, 'utf8'), XML);
          await this.storage.put(rideKey, ride, PDF);
          const patch: DocumentPatch = {
            status: 'authorized',
            authorizationNumber: auth.authorizationNumber,
            authorizedAt: auth.authorizedAt,
            xmlKey,
            rideKey,
            sriMessages: auth.messages,
            attempts: 0,
            nextRetryAt: doc.buyer.email ? now : null,
          };
          const authorized = { ...doc, ...patch, status: 'authorized' as const, sriMessages: auth.messages };
          if (!(await this.save(doc, patch, [invoiceAuthorized(authorized)]))) return;
          this.logger.log(`${docLabel(doc.docType)} ${doc.establishment}-${doc.emissionPoint}-${formatSequential(doc.sequential)} autorizada`);
          doc = { ...authorized, attempts: 0, emailedAt: null };
          if (!doc.buyer.email) return;
          break;
        }

        case 'authorized': {
          if (doc.emailedAt || !doc.buyer.email) return;
          await this.email(doc);
          await this.save(doc, { emailedAt: now, attempts: 0, nextRetryAt: null });
          return;
        }

        default:
          return; // returned, not_authorized, voided: sin trabajo automático
      }
    }
  }

  /** Falla en un paso: se suma un intento y se reprograma con backoff. */
  private async retryLater(doc: ElectronicDocumentWithLines, error: unknown, now: Date): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const row = await this.documents.findState(this.db, doc.id);
    if (!row) return;
    const attempts = row.attempts + 1;
    const { retryBaseSeconds, retryMaxSeconds } = this.config.billing;
    const patch: DocumentPatch = { attempts, nextRetryAt: this.after(now, backoffSeconds(attempts, retryBaseSeconds, retryMaxSeconds)) };
    // El envío pudo llegar al SRI (timeout esperando respuesta): queda "sent" y se reenvía.
    if (row.status === 'signed' && error instanceof SriUnavailableError && error.maybeDelivered) patch.status = 'sent';
    if (row.status === 'authorized' && attempts >= MAX_EMAIL_ATTEMPTS) {
      patch.nextRetryAt = null;
      this.logger.error(`No se pudo enviar el email de la factura ${doc.accessKey} tras ${attempts} intentos: ${message}`);
    } else {
      this.logger.warn(`Comprobante ${doc.accessKey} (${row.status}), intento ${attempts}: ${message}`);
    }
    await this.documents.update(this.db, doc.id, row.status, patch);
  }

  private async reject(doc: ElectronicDocumentWithLines, status: 'returned' | 'not_authorized', messages: SriMessage[]): Promise<void> {
    await this.save(doc, { status, sriMessages: messages, nextRetryAt: null }, [invoiceRejected(doc, status, messages)]);
    this.logger.warn(`Comprobante ${doc.accessKey} ${status === 'returned' ? 'DEVUELTO' : 'NO AUTORIZADO'}: ${messages.map((m) => `${m.identificador} ${m.mensaje}`).join('; ')}`);
  }

  /** UPDATE condicionado al estado leído + eventos en el outbox, en una transacción. */
  private save(doc: ElectronicDocumentWithLines, patch: DocumentPatch, events: DomainEvent[] = []): Promise<boolean> {
    return this.db.withTransaction(async (tx) => {
      const ok = await this.documents.update(tx, doc.id, doc.status, patch);
      if (ok) await this.outbox.append(tx, events);
      return ok;
    });
  }

  private async readSignedXml(doc: ElectronicDocumentWithLines): Promise<string> {
    const file = doc.xmlKey ? await this.storage.get(doc.xmlKey) : null;
    if (!file) throw new Error(`No está el XML firmado de ${doc.accessKey} (${doc.xmlKey ?? 'sin clave'})`);
    return file.content.toString('utf8').replace(/^<\?xml[^>]*\?>\s*/, '');
  }

  /**
   * Datos del XML y del RIDE: montos, líneas y comprador salen del documento guardado; la
   * información adicional (email, teléfono, número de pedido, dirección) del snapshot del pedido.
   */
  private async invoiceData(doc: ElectronicDocumentWithLines): Promise<InvoiceData> {
    const additionalInfo = doc.orderId ? draftInvoice(invoiceSourceFrom(await this.orders.getOrder(doc.tenantId, doc.orderId))).additionalInfo : [];
    return {
      emitter: this.config.billing.emitter,
      environment: doc.environment,
      accessKey: doc.accessKey,
      establishment: doc.establishment,
      emissionPoint: doc.emissionPoint,
      sequential: doc.sequential,
      issueDate: doc.issueDate,
      establishmentAddress: doc.establishmentAddress,
      buyer: doc.buyer,
      lines: doc.lines,
      subtotal0: doc.subtotal0,
      subtotalTaxed: doc.subtotalTaxed,
      discountTotal: doc.discountTotal,
      taxTotal: doc.taxTotal,
      total: doc.total,
      paymentForms: doc.paymentForms,
      additionalInfo,
    };
  }

  private async buildXml(doc: ElectronicDocumentWithLines): Promise<string> {
    return doc.docType === DOC_TYPE_CREDIT_NOTE ? buildCreditNoteXml(await this.creditNoteData(doc)) : buildInvoiceXml(await this.invoiceData(doc));
  }

  private async rideData(doc: ElectronicDocumentWithLines, auth: RideAuthorization): Promise<RideData> {
    return doc.docType === DOC_TYPE_CREDIT_NOTE
      ? { ...(await this.creditNoteData(doc)), docType: DOC_TYPE_CREDIT_NOTE, ...auth }
      : { ...(await this.invoiceData(doc)), ...auth };
  }

  /**
   * Datos de la nota de crédito: montos, líneas y comprador del documento guardado; número y fecha
   * de la factura modificada; motivo e información adicional de la devolución (API de Pedidos).
   */
  private async creditNoteData(doc: ElectronicDocumentWithLines): Promise<CreditNoteData> {
    const modified = doc.modifiedDocumentId ? await this.documents.findById(this.db, doc.tenantId, doc.modifiedDocumentId) : null;
    if (!modified || !doc.returnId) throw new Error(`La nota de crédito ${doc.accessKey} no tiene factura modificada o devolución`);
    const ret = await this.orders.getReturn(doc.tenantId, doc.returnId);
    const { paymentForms: _forms, ...base } = await this.invoiceData(doc);
    return {
      ...base,
      additionalInfo: creditNoteAdditionalInfo(doc.buyer.email, ret.order.orderNumber, ret.rmaNumber),
      modifiedDocument: {
        docType: DOC_TYPE_INVOICE,
        number: documentNumber(modified.establishment, modified.emissionPoint, modified.sequential),
        issueDate: modified.issueDate,
      },
      reason: creditNoteReason(ret),
    };
  }

  /** La nota de crédito espera a que su factura esté autorizada; mientras, se reprograma con backoff. */
  private async modifiedDocumentAuthorized(doc: ElectronicDocumentWithLines, now: Date): Promise<boolean> {
    const modified = doc.modifiedDocumentId ? await this.documents.findState(this.db, doc.modifiedDocumentId) : null;
    if (modified?.status === 'authorized') return true;
    const attempts = doc.attempts + 1;
    const wait = backoffSeconds(attempts, this.config.billing.authPollSeconds, this.config.billing.retryMaxSeconds);
    this.logger.warn(`Nota de crédito ${doc.accessKey}: la factura modificada está "${modified?.status ?? 'inexistente'}"; se reintenta`);
    await this.save(doc, { attempts, nextRetryAt: this.after(now, wait) });
    return false;
  }

  private async email(doc: ElectronicDocumentWithLines): Promise<void> {
    const [ride, xml] = await Promise.all([this.storage.get(doc.rideKey!), this.storage.get(doc.xmlKey!)]);
    if (!ride || !xml) throw new Error(`Faltan el RIDE o el XML autorizado de ${doc.accessKey}`);
    const number = `${doc.establishment}-${doc.emissionPoint}-${formatSequential(doc.sequential)}`;
    const store = this.config.billing.emitter.nombreComercial ?? this.config.billing.emitter.razonSocial;
    const greeting = doc.buyer.idType === '07' ? 'Hola,' : `Hola, ${doc.buyer.name}:`;
    const creditNote = doc.docType === DOC_TYPE_CREDIT_NOTE;
    const label = creditNote ? 'nota de crédito electrónica' : 'factura electrónica';
    const lines = [
      greeting,
      '',
      `Adjuntamos tu ${label} ${number} de ${store}, autorizada por el SRI.`,
      ...(creditNote ? ['Corresponde a la devolución de productos de tu pedido; el reembolso se procesa por separado.'] : []),
      `Número de autorización: ${doc.authorizationNumber}`,
      `Total: USD ${doc.total}`,
      '',
      'El archivo XML es el comprobante electrónico con validez tributaria; el PDF (RIDE) es su representación impresa.',
      doc.environment === 1 ? 'Emitida en ambiente de PRUEBAS: no tiene validez tributaria.' : '',
    ].filter((l, i, all) => l !== '' || all[i - 1] !== '');
    const file = creditNote ? 'nota-credito' : 'factura';
    await this.mailer.send({
      to: doc.buyer.email!,
      subject: `${creditNote ? 'Nota de crédito' : 'Factura'} electrónica ${number} - ${store}`,
      text: lines.join('\n'),
      html: lines.map((l) => (l ? `<p>${escapeHtml(l)}</p>` : '')).join(''),
      attachments: [
        { filename: `${file}-${number}.pdf`, content: ride.content, contentType: PDF },
        { filename: `${file}-${number}.xml`, content: xml.content, contentType: XML },
      ],
    });
  }

  private after(now: Date, seconds: number): Date {
    return new Date(now.getTime() + seconds * 1000);
  }
}

function docLabel(docType: string): string {
  return docType === DOC_TYPE_CREDIT_NOTE ? 'Nota de crédito' : 'Factura';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Archivo del comprobante autorizado, con la estructura que entrega el SRI al autorizar. */
export function authorizationFile(number: string, authorizedAt: Date, environment: string, comprobante: string): string {
  const cdata = comprobante.replace(/^<\?xml[^>]*\?>\s*/, '').split(']]>').join(']]]]><![CDATA[>');
  return (
    XML_DECLARATION +
    '<autorizacion>' +
    '<estado>AUTORIZADO</estado>' +
    `<numeroAutorizacion>${number}</numeroAutorizacion>` +
    `<fechaAutorizacion>${ecuadorDateTime(authorizedAt)}</fechaAutorizacion>` +
    `<ambiente>${environment}</ambiente>` +
    `<comprobante><![CDATA[${cdata}]]></comprobante>` +
    '</autorizacion>\n'
  );
}
