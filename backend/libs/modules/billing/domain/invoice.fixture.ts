/** Datos de prueba de los tests unitarios de Facturación (excluido del build). */
import { buildAccessKey } from './access-key';
import { CreditNoteSource, draftCreditNote } from './credit-note';
import { CreditNoteData } from './credit-note-xml';
import { draftInvoice, InvoiceSource } from './invoice';
import { InvoiceData } from './invoice-xml';

export function orderSource(overrides: Partial<InvoiceSource> = {}): InvoiceSource {
  return {
    orderId: '00000000-0000-4000-8000-000000000001',
    orderNumber: '100045',
    customer: { name: 'Ana Pérez', email: 'ana@example.test', phone: '0991234567' },
    billing: { name: 'Ana Pérez', idType: '05', idNumber: '1710034065', email: 'ana@example.test' },
    shippingAddress: { mainStreet: 'Av. Amazonas', number: 'N34-45', secondaryStreet: 'Av. República', city: 'Quito' },
    paymentMethod: 'card',
    items: [
      // 2 × 20.00 − 2.00 = 38.00 + IVA 15 % 5.70
      { sku: 'BLU-LIN-BLA-M', productName: 'Blusa lino', colorName: 'Blanco', sizeCode: 'M', quantity: 2, unitPrice: '20.00', discount: '2.00', taxCode: '4', taxAmount: '5.70' },
      // 30.00, IVA 0 %
      { sku: 'BOL-CUE-NEG', productName: 'Bolso cuero', colorName: null, sizeCode: null, quantity: 1, unitPrice: '30.00', discount: '0.00', taxCode: '0', taxAmount: '0.00' },
    ],
    shippingTotal: '3.00',
    giftCardTotal: '0.00',
    total: '76.70',
    ...overrides,
  };
}

export const EMITTER = {
  ruc: '1790000000001',
  razonSocial: 'MODA DEMO S.A.',
  nombreComercial: 'Moda Demo',
  dirMatriz: 'Av. Amazonas N34-120 y Av. de la Prensa, Quito',
  obligadoContabilidad: true,
  contribuyenteEspecial: null,
  contribuyenteRimpe: null,
};

export function invoiceData(overrides: Partial<InvoiceSource> = {}, sequential = 1): InvoiceData {
  const draft = draftInvoice(orderSource(overrides));
  const { phone: _phone, ...buyer } = draft.buyer;
  return {
    emitter: EMITTER,
    environment: 1,
    accessKey: buildAccessKey({
      issueDate: '2026-09-30',
      docType: '01',
      ruc: EMITTER.ruc,
      environment: 1,
      establishment: '001',
      emissionPoint: '001',
      sequential,
      numericCode: '12345678',
      emissionType: '1',
    }),
    establishment: '001',
    emissionPoint: '001',
    sequential,
    issueDate: '2026-09-30',
    establishmentAddress: 'Tienda en línea - Av. Amazonas N34-120, Quito',
    buyer,
    lines: draft.lines,
    subtotal0: draft.subtotal0,
    subtotalTaxed: draft.subtotalTaxed,
    discountTotal: draft.discountTotal,
    taxTotal: draft.taxTotal,
    total: draft.total,
    paymentForms: draft.paymentForms,
    additionalInfo: draft.additionalInfo,
  };
}

/** Devolución de 1 de las 2 blusas de orderSource(): 20.00 − 1.00 (mitad del descuento) = 19.00 + IVA 2.85. */
export function creditNoteSource(overrides: Partial<CreditNoteSource> = {}): CreditNoteSource {
  return {
    returnId: '00000000-0000-4000-8000-0000000000a1',
    rmaNumber: 'RMA-100045-1',
    orderNumber: '100045',
    reason: 'Talla pequeña',
    refundAmount: '21.85',
    lines: [
      {
        sku: 'BLU-LIN-BLA-M',
        productName: 'Blusa lino',
        colorName: 'Blanco',
        sizeCode: 'M',
        quantity: 1,
        unitPrice: '20.00',
        discount: '1.00',
        taxCode: '4',
        taxBase: '19.00',
        taxAmount: '2.85',
        total: '21.85',
      },
    ],
    ...overrides,
  };
}

/** Nota de crédito 001-001-000000001 sobre la factura 001-001-000000001 de invoiceData(). */
export function creditNoteData(overrides: Partial<CreditNoteSource> = {}, sequential = 1): CreditNoteData {
  const invoice = invoiceData();
  const draft = draftCreditNote(creditNoteSource(overrides), { buyer: invoice.buyer, total: invoice.total, creditedBefore: '0.00' });
  return {
    emitter: EMITTER,
    environment: 1,
    accessKey: buildAccessKey({
      issueDate: '2026-10-05',
      docType: '04',
      ruc: EMITTER.ruc,
      environment: 1,
      establishment: '001',
      emissionPoint: '001',
      sequential,
      numericCode: '87654321',
      emissionType: '1',
    }),
    establishment: '001',
    emissionPoint: '001',
    sequential,
    issueDate: '2026-10-05',
    establishmentAddress: invoice.establishmentAddress,
    buyer: draft.buyer,
    lines: draft.lines,
    subtotal0: draft.subtotal0,
    subtotalTaxed: draft.subtotalTaxed,
    discountTotal: draft.discountTotal,
    taxTotal: draft.taxTotal,
    total: draft.total,
    additionalInfo: draft.additionalInfo,
    modifiedDocument: { docType: '01', number: '001-001-000000001', issueDate: invoice.issueDate },
    reason: draft.reason,
  };
}
