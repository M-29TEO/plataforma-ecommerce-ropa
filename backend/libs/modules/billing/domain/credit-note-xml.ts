import { fromCents, toCents } from '../../../shared-kernel';
import { sriDate } from './dates';
import { taxTotals } from './invoice';
import { DOC_TYPE_INVOICE, formatSequential, InvoiceData } from './invoice-xml';
import { el, escapeText, leaf } from './xml';

/** Versión del esquema de nota de crédito de la ficha técnica (hasta 6 decimales en cantidad y precio). */
export const CREDIT_NOTE_XML_VERSION = '1.1.0';
export const DOC_TYPE_CREDIT_NOTE = '04';

/** Comprobante que la nota de crédito modifica (la factura del pedido). */
export interface ModifiedDocument {
  docType: typeof DOC_TYPE_INVOICE;
  /** 001-001-000000123 */
  number: string;
  /** AAAA-MM-DD */
  issueDate: string;
}

/** Todo lo que va en el XML y en el RIDE de una nota de crédito. */
export interface CreditNoteData extends Omit<InvoiceData, 'paymentForms'> {
  modifiedDocument: ModifiedDocument;
  /** Motivo (campo motivo, máx. 300). */
  reason: string;
}

function rate(value: string): string {
  return String(Number(value));
}

function money(value: string): string {
  return Number(value).toFixed(2);
}

export function documentNumber(establishment: string, emissionPoint: string, sequential: number): string {
  return `${establishment}-${emissionPoint}-${formatSequential(sequential)}`;
}

/**
 * Nota de crédito versión 1.1.0 (ficha técnica del SRI, esquema offline), SIN firma y en forma
 * canónica, con id="comprobante" en la raíz (lo referencia la firma XAdES). A diferencia de la
 * factura, no lleva formas de pago: lleva el documento modificado, el valor de la modificación y
 * el motivo, y el detalle usa codigoInterno en lugar de codigoPrincipal.
 */
export function buildCreditNoteXml(d: CreditNoteData): string {
  const e = d.emitter;
  const infoTributaria = el('infoTributaria', [
    leaf('ambiente', d.environment),
    leaf('tipoEmision', '1'),
    leaf('razonSocial', e.razonSocial),
    leaf('nombreComercial', e.nombreComercial),
    leaf('ruc', e.ruc),
    leaf('claveAcceso', d.accessKey),
    leaf('codDoc', DOC_TYPE_CREDIT_NOTE),
    leaf('estab', d.establishment),
    leaf('ptoEmi', d.emissionPoint),
    leaf('secuencial', formatSequential(d.sequential)),
    leaf('dirMatriz', e.dirMatriz),
    leaf('contribuyenteRimpe', e.contribuyenteRimpe),
  ]);

  const totalConImpuestos = el(
    'totalConImpuestos',
    taxTotals(d.lines).map((t) =>
      el('totalImpuesto', [leaf('codigo', t.taxCode), leaf('codigoPorcentaje', t.rateCode), leaf('baseImponible', t.base), leaf('valor', t.amount)]),
    ),
  );

  const infoNotaCredito = el('infoNotaCredito', [
    leaf('fechaEmision', sriDate(d.issueDate)),
    leaf('dirEstablecimiento', d.establishmentAddress),
    leaf('tipoIdentificacionComprador', d.buyer.idType),
    leaf('razonSocialComprador', d.buyer.name),
    leaf('identificacionComprador', d.buyer.idNumber),
    leaf('contribuyenteEspecial', e.contribuyenteEspecial),
    leaf('obligadoContabilidad', e.obligadoContabilidad ? 'SI' : 'NO'),
    leaf('codDocModificado', d.modifiedDocument.docType),
    leaf('numDocModificado', d.modifiedDocument.number),
    leaf('fechaEmisionDocSustento', sriDate(d.modifiedDocument.issueDate)),
    leaf('totalSinImpuestos', fromCents(toCents(d.subtotal0) + toCents(d.subtotalTaxed))),
    leaf('valorModificacion', money(d.total)),
    leaf('moneda', 'DOLAR'),
    totalConImpuestos,
    leaf('motivo', d.reason),
  ]);

  const detalles = el(
    'detalles',
    d.lines.map((l) =>
      el('detalle', [
        leaf('codigoInterno', l.mainCode),
        leaf('codigoAdicional', l.auxCode),
        leaf('descripcion', l.description),
        leaf('cantidad', l.quantity.toFixed(2)),
        leaf('precioUnitario', money(l.unitPrice)),
        leaf('descuento', money(l.discount)),
        leaf('precioTotalSinImpuesto', money(l.taxBase)),
        el(
          'impuestos',
          el('impuesto', [
            leaf('codigo', l.taxCode),
            leaf('codigoPorcentaje', l.taxRateCode),
            leaf('tarifa', rate(l.taxRate)),
            leaf('baseImponible', money(l.taxBase)),
            leaf('valor', money(l.taxAmount)),
          ]),
        ),
      ]),
    ),
  );

  const infoAdicional = d.additionalInfo.length
    ? el('infoAdicional', d.additionalInfo.slice(0, 15).map((f) => el('campoAdicional', escapeText(f.value), { nombre: f.name })))
    : '';

  return el('notaCredito', [infoTributaria, infoNotaCredito, detalles, infoAdicional], { id: 'comprobante', version: CREDIT_NOTE_XML_VERSION });
}
