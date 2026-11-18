import { formatRate, fromCents, ivaCents, ivaRateBp, toCents } from '../../../shared-kernel';
import { BUYER_ID_TYPES, CONSUMIDOR_FINAL_ID } from './buyer-id';
import { CreditNoteNotAllowedError, InvalidInvoiceError } from './errors';
import { AdditionalField, InvoiceBuyer, InvoiceLine, TAX_IVA } from './invoice';

/**
 * Nota de crédito (tipo 04) por una devolución: anula en la factura original el valor de las
 * unidades devueltas. Los montos por línea los calcula Pedidos (el mismo cálculo del reembolso);
 * aquí se verifica que cuadren con la regla del IVA y con el monto reembolsado.
 */

export interface CreditNoteSourceLine {
  sku: string;
  productName: string;
  colorName: string | null;
  sizeCode: string | null;
  quantity: number;
  /** Sin IVA. */
  unitPrice: string;
  /** Descuento de las unidades devueltas (prorrateado de la línea del pedido). */
  discount: string;
  /** Código de porcentaje de IVA del SRI. */
  taxCode: string;
  taxBase: string;
  taxAmount: string;
  total: string;
}

export interface CreditNoteSource {
  returnId: string;
  rmaNumber: string;
  orderNumber: string;
  /** Motivo de la devolución (texto del cliente o de los códigos de motivo). */
  reason: string;
  /** Lo reembolsado: debe ser igual al total de la nota de crédito. */
  refundAmount: string;
  lines: CreditNoteSourceLine[];
}

/** Lo que la nota de crédito toma de la factura que modifica. */
export interface InvoiceReference {
  buyer: Omit<InvoiceBuyer, 'phone'>;
  total: string;
  /** Suma de las notas de crédito vigentes emitidas antes sobre la misma factura. */
  creditedBefore: string;
}

export interface CreditNoteDraft {
  buyer: Omit<InvoiceBuyer, 'phone'>;
  lines: InvoiceLine[];
  subtotal0: string;
  subtotalTaxed: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  reason: string;
  additionalInfo: AdditionalField[];
}

function lineDescription(l: CreditNoteSourceLine): string {
  return [l.productName.trim(), l.colorName, l.sizeCode && `Talla ${l.sizeCode}`].filter(Boolean).join(' - ').slice(0, 300);
}

/** "Devolución RMA-100045-1: Talla pequeña" (máx. 300, campo motivo del SRI). */
export function creditNoteReason(src: Pick<CreditNoteSource, 'rmaNumber' | 'reason'>): string {
  return `Devolución ${src.rmaNumber}: ${src.reason.trim()}`.slice(0, 300);
}

/** Información adicional del XML y del RIDE de la nota de crédito. */
export function creditNoteAdditionalInfo(email: string | null, orderNumber: string, rmaNumber: string): AdditionalField[] {
  return [...(email ? [{ name: 'Email', value: email }] : []), { name: 'Pedido', value: `#${orderNumber}` }, { name: 'Devolución', value: rmaNumber }];
}

export function draftCreditNote(src: CreditNoteSource, invoice: InvoiceReference): CreditNoteDraft {
  if (!src.lines.length) throw new InvalidInvoiceError('EMPTY_CREDIT_NOTE', 'La devolución no tiene líneas', { returnId: src.returnId });
  // El SRI no admite notas de crédito a consumidor final: la devolución se liquida sin comprobante electrónico.
  if (invoice.buyer.idType === BUYER_ID_TYPES.CONSUMIDOR_FINAL || invoice.buyer.idNumber === CONSUMIDOR_FINAL_ID) {
    throw new CreditNoteNotAllowedError(src.returnId);
  }

  const lines: InvoiceLine[] = src.lines.map((l) => {
    const base = l.quantity * toCents(l.unitPrice) - toCents(l.discount);
    const tax = ivaCents(base, ivaRateBp(l.taxCode));
    if (base < 0 || base !== toCents(l.taxBase) || tax !== toCents(l.taxAmount) || base + tax !== toCents(l.total)) {
      throw new InvalidInvoiceError('LINE_TAX_MISMATCH', 'El valor de la línea devuelta no corresponde a su base e IVA', {
        returnId: src.returnId,
        sku: l.sku,
      });
    }
    return {
      mainCode: l.sku.slice(0, 25),
      auxCode: null,
      description: lineDescription(l),
      quantity: l.quantity,
      unitPrice: fromCents(toCents(l.unitPrice)),
      discount: fromCents(toCents(l.discount)),
      taxCode: TAX_IVA,
      taxRateCode: l.taxCode,
      taxRate: formatRate(ivaRateBp(l.taxCode)),
      taxBase: fromCents(base),
      taxAmount: fromCents(tax),
      lineTotal: fromCents(base + tax),
    };
  });

  let subtotal0 = 0;
  let subtotalTaxed = 0;
  let taxTotal = 0;
  let discountTotal = 0;
  for (const l of lines) {
    if (ivaRateBp(l.taxRateCode) === 0) subtotal0 += toCents(l.taxBase);
    else subtotalTaxed += toCents(l.taxBase);
    taxTotal += toCents(l.taxAmount);
    discountTotal += toCents(l.discount);
  }
  const total = subtotal0 + subtotalTaxed + taxTotal;
  if (total !== toCents(src.refundAmount)) {
    throw new InvalidInvoiceError('TOTAL_MISMATCH', 'El total de la nota de crédito no coincide con lo reembolsado', {
      returnId: src.returnId,
      creditNoteTotal: fromCents(total),
      refundAmount: src.refundAmount,
    });
  }
  if (total + toCents(invoice.creditedBefore) > toCents(invoice.total)) {
    throw new InvalidInvoiceError('CREDIT_EXCEEDS_INVOICE', 'Las notas de crédito superarían el total de la factura', {
      returnId: src.returnId,
      invoiceTotal: invoice.total,
      creditedBefore: invoice.creditedBefore,
      creditNoteTotal: fromCents(total),
    });
  }

  const additionalInfo = creditNoteAdditionalInfo(invoice.buyer.email, src.orderNumber, src.rmaNumber);
  return {
    buyer: invoice.buyer,
    lines,
    subtotal0: fromCents(subtotal0),
    subtotalTaxed: fromCents(subtotalTaxed),
    discountTotal: fromCents(discountTotal),
    taxTotal: fromCents(taxTotal),
    total: fromCents(total),
    reason: creditNoteReason(src),
    additionalInfo,
  };
}
