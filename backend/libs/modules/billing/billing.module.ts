import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, createObjectStorage } from '../../shared-kernel';
import { OrdersModule } from '../orders';
import { BillingDocumentsController, MyInvoiceController } from './api/billing.controller';
import { BillingApi } from './application/billing.api';
import { CreditNoteIssuer } from './application/credit-note-issuer.service';
import { DocumentProcessor } from './application/document-processor.service';
import { DocumentQueryService } from './application/document-query.service';
import { InvoiceIssuer } from './application/invoice-issuer.service';
import { DocumentRepository, DocumentStorage, InvoiceMailer, InvoiceSigner, RideRenderer, SriPort } from './application/ports';
import { BillingMetrics } from './infrastructure/billing-metrics';
import { BillingConsumer } from './infrastructure/consumers/billing.consumer';
import { ProcessDocumentsJob } from './infrastructure/jobs/process-documents.job';
import { InMemoryInvoiceMailer, SmtpInvoiceMailer } from './infrastructure/mail/invoice-mailer';
import { BillingPersonalDataContributor } from './infrastructure/personal-data.contributor';
import { PgDocumentRepository } from './infrastructure/pg-document.repository';
import { PdfRideRenderer } from './infrastructure/ride/ride-pdf';
import { PemInvoiceSigner } from './infrastructure/signing/pem-invoice-signer';
import { SriSoapAdapter } from './infrastructure/sri/sri-soap.adapter';

/**
 * Módulo Facturación electrónica SRI (schema billing: emission_points, sequences,
 * electronic_documents, electronic_document_lines): facturas (01) y notas de crédito (04). Requiere ConfigModule, DatabaseModule y
 * OutboxModule del shared kernel; lee los pedidos por la API pública de Pedidos.
 *
 * Adaptadores: SriPort → SOAP offline (simulador, celcer o cel según SRI_MODE), InvoiceSigner →
 * XAdES-BES con el certificado PEM, RideRenderer → PDF propio, DocumentStorage → SeaweedFS o
 * memoria (DOCUMENT_STORAGE), InvoiceMailer → SMTP/Mailpit o memoria (MAIL_TRANSPORT).
 */
@Module({
  imports: [OrdersModule],
  controllers: [BillingDocumentsController, MyInvoiceController],
  providers: [
    { provide: DocumentRepository, useClass: PgDocumentRepository },
    { provide: SriPort, useClass: SriSoapAdapter },
    { provide: InvoiceSigner, useClass: PemInvoiceSigner },
    { provide: RideRenderer, useClass: PdfRideRenderer },
    {
      provide: DocumentStorage,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => createObjectStorage(c.billing.storage, c.billing.seaweedFilerUrl),
    },
    {
      provide: InvoiceMailer,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) =>
        c.billing.mailTransport === 'memory' ? new InMemoryInvoiceMailer() : new SmtpInvoiceMailer(c.billing.smtpUrl, c.billing.mailFrom),
    },
    InvoiceIssuer,
    CreditNoteIssuer,
    DocumentProcessor,
    DocumentQueryService,
    BillingApi,
    BillingPersonalDataContributor,
  ],
  exports: [BillingApi, InvoiceIssuer, CreditNoteIssuer, DocumentProcessor],
})
export class BillingModule {}

/** Consumidores de eventos de otros módulos (proceso worker; en tests, junto con el relay). */
@Module({ imports: [BillingModule], providers: [BillingConsumer] })
export class BillingConsumersModule {}

/** Jobs del proceso worker y métricas de comprobantes pendientes con el SRI. Requiere QueueModule. */
@Module({ imports: [BillingModule], providers: [ProcessDocumentsJob, BillingMetrics] })
export class BillingWorkerModule {}
