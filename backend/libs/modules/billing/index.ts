/**
 * API PÚBLICA del módulo Facturación. Otros módulos solo pueden importar desde aquí.
 */
export { BillingConsumersModule, BillingModule, BillingWorkerModule } from './billing.module';
export { BillingApi } from './application/billing.api';
export type { DocumentView } from './application/document-query.service';
export type { IssueResult } from './application/invoice-issuer.service';
export type { CreditNoteIssueResult } from './application/credit-note-issuer.service';
export { BUYER_ID_TYPES, CONSUMIDOR_FINAL_ID, CONSUMIDOR_FINAL_NAME } from './domain/buyer-id';
export type { DocumentStatus } from './domain/electronic-document';
export { INVOICE_AUTHORIZED, INVOICE_REJECTED } from './domain/events';
export type { InvoiceAuthorizedPayload, InvoiceRejectedPayload } from './domain/events';
export {
  BuyerIdRequiredError,
  CreditNoteNotAllowedError,
  DocumentNotFoundError,
  EmissionPointNotConfiguredError,
  InvalidBuyerIdError,
  InvoiceToModifyNotFoundError,
} from './domain/errors';
