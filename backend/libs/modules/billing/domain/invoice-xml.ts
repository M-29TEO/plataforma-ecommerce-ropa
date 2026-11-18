import { fromCents, toCents } from '../../../shared-kernel';
import { sriDate } from './dates';
import { AdditionalField, InvoiceBuyer, InvoiceLine, PaymentForm, taxTotals } from './invoice';
import { el, escapeText, leaf } from './xml';

/** Versión del esquema de factura de la ficha técnica (hasta 6 decimales en cantidad y precio). */
export const INVOICE_XML_VERSION = '2.1.0';
export const DOC_TYPE_INVOICE = '01';

export interface Emitter {
  ruc: string;
  razonSocial: string;
  nombreComercial: string | null;
  dirMatriz: string;
  obligadoContabilidad: boolean;
  contribuyenteEspecial: string | null;
  contribuyenteRimpe: string | null;
}

/** Todo lo que va en el XML y en el RIDE de una factura. */
export interface InvoiceData {
  emitter: Emitter;
  environment: 1 | 2;
  accessKey: string;
  establishment: string;
  emissionPoint: string;
  sequential: number;
  /** AAAA-MM-DD */
  issueDate: string;
  establishmentAddress: string;
  buyer: Omit<InvoiceBuyer, 'phone'>;
  lines: InvoiceLine[];
  subtotal0: string;
  subtotalTaxed: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  paymentForms: PaymentForm[];
  additionalInfo: AdditionalField[];
}

export function formatSequential(n: number): string {
  return String(n).padStart(9, '0');
}

/** "15.00" → "15"; "12.50" → "12.5" (tarifa del impuesto). */
function rate(value: string): string {
  return String(Number(value));
}

function money(value: string): string {
  return Number(value).toFixed(2);
}

/**
 * Factura electrónica versión 2.1.0 (ficha técnica del SRI, esquema offline), SIN firma y en
 * forma canónica. El elemento raíz lleva id="comprobante": la firma XAdES lo referencia.
 * Solo se escriben los campos que usa una tienda en línea; los opcionales vacíos se omiten.
 */
export function buildInvoiceXml(d: InvoiceData): string {
  const e = d.emitter;
  const infoTributaria = el('infoTributaria', [
    leaf('ambiente', d.environment),
    leaf('tipoEmision', '1'),
    leaf('razonSocial', e.razonSocial),
    leaf('nombreComercial', e.nombreComercial),
    leaf('ruc', e.ruc),
    leaf('claveAcceso', d.accessKey),
    leaf('codDoc', DOC_TYPE_INVOICE),
    leaf('estab', d.establishment),
    leaf('ptoEmi', d.emissionPoint),
    leaf('secuencial', formatSequential(d.sequential)),
    leaf('dirMatriz', e.dirMatriz),
    leaf('contribuyenteRimpe', e.contribuyenteRimpe),
  ]);

  const totalConImpuestos = el(
    'totalConImpuestos',
    taxTotals(d.lines).map((t) =>
      el('totalImpuesto', [
        leaf('codigo', t.taxCode),
        leaf('codigoPorcentaje', t.rateCode),
        leaf('baseImponible', t.base),
        leaf('valor', t.amount),
      ]),
    ),
  );

  const pagos = el(
    'pagos',
    d.paymentForms.map((p) => el('pago', [leaf('formaPago', p.code), leaf('total', money(p.total))])),
  );

  const infoFactura = el('infoFactura', [
    leaf('fechaEmision', sriDate(d.issueDate)),
    leaf('dirEstablecimiento', d.establishmentAddress),
    leaf('contribuyenteEspecial', e.contribuyenteEspecial),
    leaf('obligadoContabilidad', e.obligadoContabilidad ? 'SI' : 'NO'),
    leaf('tipoIdentificacionComprador', d.buyer.idType),
    leaf('razonSocialComprador', d.buyer.name),
    leaf('identificacionComprador', d.buyer.idNumber),
    leaf('direccionComprador', d.buyer.address),
    leaf('totalSinImpuestos', fromCents(toCents(d.subtotal0) + toCents(d.subtotalTaxed))),
    leaf('totalDescuento', money(d.discountTotal)),
    totalConImpuestos,
    leaf('propina', '0.00'),
    leaf('importeTotal', money(d.total)),
    leaf('moneda', 'DOLAR'),
    pagos,
  ]);

  const detalles = el(
    'detalles',
    d.lines.map((l) =>
      el('detalle', [
        leaf('codigoPrincipal', l.mainCode),
        leaf('codigoAuxiliar', l.auxCode),
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
    ? el(
        'infoAdicional',
        d.additionalInfo.slice(0, 15).map((f) => el('campoAdicional', escapeText(f.value), { nombre: f.name })),
      )
    : '';

  return el('factura', [infoTributaria, infoFactura, detalles, infoAdicional], { id: 'comprobante', version: INVOICE_XML_VERSION });
}

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';
