import { formatRate, fromCents, ivaCents, ivaRateBp, toCents } from '../../../shared-kernel';
import { BUYER_ID_TYPES, CONSUMIDOR_FINAL_ID, CONSUMIDOR_FINAL_NAME } from './buyer-id';
import { BuyerIdRequiredError, InvalidInvoiceError } from './errors';

/**
 * Del pedido pagado a la factura (tipo 01). Todo sale del snapshot del pedido: si el catálogo
 * cambia, la factura no cambia. Los montos viajan como string de 2 decimales, como en la base.
 */

/** Código de impuesto del SRI (tabla 16): 2 = IVA. */
export const TAX_IVA = '2';
/** Código de porcentaje de IVA 0 % (tabla 17). */
const IVA_0 = '0';
export const SHIPPING_CODE = 'ENVIO';

export interface InvoiceSourceLine {
  sku: string;
  productName: string;
  colorName: string | null;
  sizeCode: string | null;
  quantity: number;
  /** Sin IVA. */
  unitPrice: string;
  /** Descuento total de la línea. */
  discount: string;
  /** Código de porcentaje de IVA del SRI ('4' = 15 %). */
  taxCode: string;
  taxAmount: string;
}

/** Lo que Facturación necesita del pedido (se arma desde OrdersApi en la capa de aplicación). */
export interface InvoiceSource {
  orderId: string;
  orderNumber: string;
  customer: { name: string; email: string; phone?: string | null };
  /** Snapshot de facturación del checkout: { name, idType, idNumber, email, address }. */
  billing: Record<string, unknown>;
  shippingAddress: Record<string, unknown> | null;
  paymentMethod: string;
  items: InvoiceSourceLine[];
  shippingTotal: string;
  giftCardTotal: string;
  /** Lo que pagó el cliente (ya descontada la gift card). */
  total: string;
}

export interface InvoiceBuyer {
  idType: string;
  idNumber: string;
  name: string;
  email: string | null;
  address: string | null;
  phone: string | null;
}

export interface InvoiceLine {
  mainCode: string;
  auxCode: string | null;
  description: string;
  quantity: number;
  unitPrice: string;
  discount: string;
  taxCode: string;
  /** Código de porcentaje (tabla 17). */
  taxRateCode: string;
  /** "15.00" */
  taxRate: string;
  /** precioTotalSinImpuesto = cantidad × precio − descuento. */
  taxBase: string;
  taxAmount: string;
  /** Base + IVA (igual que order_items.line_total). */
  lineTotal: string;
}

export interface PaymentForm {
  /** Tabla 24 de la ficha técnica. */
  code: string;
  total: string;
}

export interface AdditionalField {
  name: string;
  value: string;
}

export interface InvoiceDraft {
  buyer: InvoiceBuyer;
  lines: InvoiceLine[];
  /** Base imponible con tarifa 0 % (incluye no objeto y exento). */
  subtotal0: string;
  subtotalTaxed: string;
  discountTotal: string;
  taxTotal: string;
  /** importeTotal: incluye lo pagado con gift card. */
  total: string;
  paymentForms: PaymentForm[];
  additionalInfo: AdditionalField[];
}

/** Formas de pago del SRI (tabla 24). */
export const PAYMENT_FORM_NAMES: Readonly<Record<string, string>> = {
  '01': 'SIN UTILIZACIÓN DEL SISTEMA FINANCIERO',
  '15': 'COMPENSACIÓN DE DEUDAS',
  '16': 'TARJETA DE DÉBITO',
  '17': 'DINERO ELECTRÓNICO',
  '18': 'TARJETA PREPAGO',
  '19': 'TARJETA DE CRÉDITO',
  '20': 'OTROS CON UTILIZACIÓN DEL SISTEMA FINANCIERO',
  '21': 'ENDOSO DE TÍTULOS',
};

/**
 * Método de pago del pedido → forma de pago del SRI. Contra entrega se cobra en efectivo (01);
 * DeUna, Banco Pichincha, transferencia y QR mueven dinero por el sistema financiero (20); la gift
 * card es saldo prepagado de la tienda (18).
 */
export const PAYMENT_FORM_BY_METHOD: Readonly<Record<string, string>> = {
  card: '19',
  deuna: '20',
  pichincha: '20',
  transfer: '20',
  qr: '20',
  cod: '01',
  gift_card: '18',
};

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function formatAddress(a: Record<string, unknown> | null): string | null {
  if (!a) return null;
  const street = [text(a.mainStreet), text(a.number), text(a.secondaryStreet) && `y ${text(a.secondaryStreet)}`].filter(Boolean).join(' ');
  const out = [street, text(a.city)].filter(Boolean).join(', ');
  return out || null;
}

/**
 * Comprador de la factura. Si el checkout no recibió identificación, la factura es a
 * CONSUMIDOR FINAL (07 / 9999999999999). La identificación no se valida aquí: la valida el
 * checkout antes de vender, y si un pedido antiguo trae una inválida, el SRI la devuelve y queda
 * a la vista del backoffice (una factura no se inventa ni se descarta en silencio).
 */
export function resolveBuyer(src: Pick<InvoiceSource, 'billing' | 'customer' | 'shippingAddress'>): InvoiceBuyer {
  const b = src.billing ?? {};
  const idType = text(b.idType);
  const idNumber = text(b.idNumber);
  const email = text(b.email) ?? text(src.customer.email);
  const phone = text(src.customer.phone);
  if (!idType || !idNumber || idType === BUYER_ID_TYPES.CONSUMIDOR_FINAL || idNumber === CONSUMIDOR_FINAL_ID) {
    return {
      idType: BUYER_ID_TYPES.CONSUMIDOR_FINAL,
      idNumber: CONSUMIDOR_FINAL_ID,
      name: CONSUMIDOR_FINAL_NAME,
      email,
      address: text(b.address),
      phone,
    };
  }
  return {
    idType,
    idNumber,
    name: text(b.name) ?? src.customer.name.trim(),
    email,
    address: text(b.address) ?? formatAddress(src.shippingAddress),
    phone,
  };
}

export function isConsumerFinal(idType: string | null | undefined, idNumber?: string | null): boolean {
  return !idType || !idNumber || idType === BUYER_ID_TYPES.CONSUMIDOR_FINAL || idNumber === CONSUMIDOR_FINAL_ID;
}

/** Límite del SRI para facturas a consumidor final. limitCents 0 = sin límite. */
export function assertConsumerFinalAllowed(totalCents: number, limitCents: number): void {
  if (limitCents > 0 && totalCents > limitCents) throw new BuyerIdRequiredError(fromCents(totalCents), fromCents(limitCents));
}

function lineDescription(i: InvoiceSourceLine): string {
  return [i.productName.trim(), i.colorName, i.sizeCode && `Talla ${i.sizeCode}`].filter(Boolean).join(' - ').slice(0, 300);
}

function line(l: Omit<InvoiceLine, 'taxBase' | 'taxRate' | 'lineTotal' | 'taxCode'>, baseCents: number, taxCents: number): InvoiceLine {
  return {
    ...l,
    taxCode: TAX_IVA,
    taxRate: formatRate(ivaRateBp(l.taxRateCode)),
    taxBase: fromCents(baseCents),
    lineTotal: fromCents(baseCents + taxCents),
  };
}

export function draftInvoice(src: InvoiceSource): InvoiceDraft {
  if (!src.items.length) throw new InvalidInvoiceError('EMPTY_INVOICE', 'El pedido no tiene ítems que facturar', { orderId: src.orderId });

  const lines: InvoiceLine[] = src.items.map((i) => {
    const baseCents = i.quantity * toCents(i.unitPrice) - toCents(i.discount);
    const taxCents = toCents(i.taxAmount);
    // El pedido ya calculó el IVA por línea con la misma regla; si no coincide, algo se corrompió.
    if (baseCents < 0 || ivaCents(baseCents, ivaRateBp(i.taxCode)) !== taxCents) {
      throw new InvalidInvoiceError('LINE_TAX_MISMATCH', 'El IVA de la línea no corresponde a su base', { orderId: src.orderId, sku: i.sku });
    }
    return line(
      {
        mainCode: i.sku.slice(0, 25),
        auxCode: null,
        description: lineDescription(i),
        quantity: i.quantity,
        unitPrice: fromCents(toCents(i.unitPrice)),
        discount: fromCents(toCents(i.discount)),
        taxRateCode: i.taxCode,
        taxAmount: fromCents(taxCents),
      },
      baseCents,
      taxCents,
    );
  });

  // El envío se cobra sin IVA en el pedido (transporte de carga, IVA 0 %): va como una línea más.
  const shippingCents = toCents(src.shippingTotal);
  if (shippingCents > 0) {
    lines.push(
      line(
        { mainCode: SHIPPING_CODE, auxCode: null, description: 'Servicio de envío', quantity: 1, unitPrice: fromCents(shippingCents), discount: '0.00', taxRateCode: IVA_0, taxAmount: '0.00' },
        shippingCents,
        0,
      ),
    );
  }

  let subtotal0 = 0;
  let subtotalTaxed = 0;
  let taxTotal = 0;
  let discountTotal = 0;
  for (const l of lines) {
    const base = toCents(l.taxBase);
    if (ivaRateBp(l.taxRateCode) === 0) subtotal0 += base;
    else subtotalTaxed += base;
    taxTotal += toCents(l.taxAmount);
    discountTotal += toCents(l.discount);
  }
  const totalCents = subtotal0 + subtotalTaxed + taxTotal;
  const giftCardCents = toCents(src.giftCardTotal);
  const paidCents = toCents(src.total);
  if (totalCents !== paidCents + giftCardCents) {
    throw new InvalidInvoiceError('TOTAL_MISMATCH', 'El total de la factura no coincide con el del pedido', {
      orderId: src.orderId,
      invoiceTotal: fromCents(totalCents),
      orderTotal: fromCents(paidCents + giftCardCents),
    });
  }

  return {
    buyer: resolveBuyer(src),
    lines,
    subtotal0: fromCents(subtotal0),
    subtotalTaxed: fromCents(subtotalTaxed),
    discountTotal: fromCents(discountTotal),
    taxTotal: fromCents(taxTotal),
    total: fromCents(totalCents),
    paymentForms: paymentForms(src.paymentMethod, paidCents, giftCardCents),
    additionalInfo: additionalInfo(src),
  };
}

function paymentForms(method: string, paidCents: number, giftCardCents: number): PaymentForm[] {
  const byCode = new Map<string, number>();
  const add = (code: string, cents: number) => {
    if (cents > 0) byCode.set(code, (byCode.get(code) ?? 0) + cents);
  };
  const code = PAYMENT_FORM_BY_METHOD[method];
  if (paidCents > 0 && !code) throw new InvalidInvoiceError('UNKNOWN_PAYMENT_METHOD', 'Método de pago sin forma de pago del SRI', { method });
  add(code, paidCents);
  add(PAYMENT_FORM_BY_METHOD.gift_card, giftCardCents);
  return [...byCode].map(([c, cents]) => ({ code: c, total: fromCents(cents) }));
}

function additionalInfo(src: InvoiceSource): AdditionalField[] {
  const b = src.billing ?? {};
  const fields: [string, string | null][] = [
    ['Email', text(b.email) ?? text(src.customer.email)],
    ['Teléfono', text(src.customer.phone)],
    ['Pedido', `#${src.orderNumber}`],
    ['Dirección de entrega', formatAddress(src.shippingAddress)],
  ];
  return fields.filter((f): f is [string, string] => !!f[1]).map(([name, value]) => ({ name, value: value.slice(0, 300) }));
}

export interface TaxTotal {
  taxCode: string;
  rateCode: string;
  rate: string;
  base: string;
  amount: string;
}

/** totalConImpuestos: bases e IVA agrupados por código de porcentaje, en orden de código. */
export function taxTotals(lines: Pick<InvoiceLine, 'taxCode' | 'taxRateCode' | 'taxRate' | 'taxBase' | 'taxAmount'>[]): TaxTotal[] {
  const groups = new Map<string, { taxCode: string; rateCode: string; rate: string; base: number; amount: number }>();
  for (const l of lines) {
    const key = `${l.taxCode}:${l.taxRateCode}`;
    const g = groups.get(key) ?? { taxCode: l.taxCode, rateCode: l.taxRateCode, rate: l.taxRate, base: 0, amount: 0 };
    g.base += toCents(l.taxBase);
    g.amount += toCents(l.taxAmount);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => a.taxCode.localeCompare(b.taxCode) || Number(a.rateCode) - Number(b.rateCode))
    .map((g) => ({ taxCode: g.taxCode, rateCode: g.rateCode, rate: g.rate, base: fromCents(g.base), amount: fromCents(g.amount) }));
}
