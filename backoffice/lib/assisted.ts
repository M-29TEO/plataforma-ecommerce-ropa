import type { Tone } from '@/components/ui/Badge';
import { toNumber } from './format';
import type { VariantLookupItem } from './scanner';

/**
 * Pedidos asistidos (/v1/assisted-orders): tipos del API y lógica pura del asistente del
 * vendedor (validación de cédula/RUC y teléfono, carrito local, cuerpo de quote/create, opción de
 * envío elegida y mensajes para WhatsApp). Contrato en
 * backend/libs/modules/checkout/api/assisted-orders.controller.ts y su DTO.
 */

// ---------------------------------------------------------------- Tipos del API

export type FulfillmentKind = 'rider' | 'courier' | 'pickup';
export type AssistedPaymentMethod = 'transfer' | 'cod' | 'card_link';
/** Tipos de identificación del SRI que acepta el API: 04 RUC, 05 cédula, 06 pasaporte. */
export type IdType = '04' | '05' | '06';

export const ID_TYPE_LABEL: Record<IdType, string> = { '04': 'RUC', '05': 'Cédula', '06': 'Pasaporte' };

export const PAYMENT_METHOD_OPTIONS: { value: AssistedPaymentMethod; label: string; hint: string }[] = [
  { value: 'transfer', label: 'Transferencia', hint: 'El cliente transfiere y envía el comprobante.' },
  { value: 'cod', label: 'Contra entrega', hint: 'Paga en efectivo al recibir.' },
  { value: 'card_link', label: 'Enlace de pago con tarjeta', hint: 'Se le envía un enlace a la pasarela.' },
];

export const FULFILLMENT_OPTIONS: { value: FulfillmentKind; label: string }[] = [
  { value: 'rider', label: 'Motorizado' },
  { value: 'courier', label: 'Courier' },
  { value: 'pickup', label: 'Retiro en tienda' },
];

/** GET /assisted-orders/customers → addresses[] (lat/lng null = sin pin en el mapa). */
export interface CustomerAddress {
  addressId: string;
  label: string | null;
  isDefault: boolean;
  recipientName: string;
  recipientPhone: string;
  mainStreet: string;
  secondaryStreet: string | null;
  number: string | null;
  reference: string | null;
  neighborhood: string | null;
  city: string;
  province: string;
  lat: number | null;
  lng: number | null;
}

export interface AssistedCustomer {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  idType: string | null;
  idNumber: string | null;
  status: 'pending' | 'active' | 'blocked';
  addresses: CustomerAddress[];
}

export type StockIssueCode = 'INSUFFICIENT_STOCK' | 'OUT_OF_STOCK' | 'UNAVAILABLE';

export interface QuoteIssue {
  code: StockIssueCode;
  message: string;
  available?: number;
}

export interface QuoteCoupon {
  code: string;
  applied: boolean;
  discount: string | null;
  reason: string | null;
  message: string | null;
}

export interface QuoteTotals {
  subtotal: string;
  discountTotal: string;
  shippingTotal: string;
  taxTotal: string;
  total: string;
}

export interface QuoteSlot {
  slotId: string;
  date?: string;
  startsAt: string;
  endsAt?: string;
  available?: number;
  surcharge?: string;
  price: string;
  shippingTotal: string;
  total: string;
}

export interface QuoteOption {
  /** Token firmado: va en fulfillment.quoteToken al crear. Cambia en cada cotización. */
  quoteId: string;
  type: 'rider' | 'courier';
  price: string;
  label: string;
  etaHours?: number | null;
  courier?: { code: string; name: string };
  service?: { code: string; name: string };
  shippingTotal: string;
  total: string;
  slots?: QuoteSlot[];
}

export interface QuoteDelivery {
  fulfillmentType: 'rider' | 'courier';
  reason: string | null;
  zone: { id: string; name: string; city: string; deliveryMode: string } | null;
  parcel: { weightG: number; volumeCm3: number; chargeableKg: number };
  validUntil: string;
  options: QuoteOption[];
}

export interface QuoteLine {
  variantId: string;
  sku: string | null;
  productName: string | null;
  colorName: string | null;
  sizeCode: string | null;
  quantity: number;
  availableQuantity: number;
  unitPrice: string | null;
  total: string | null;
}

/** POST /assisted-orders/quote */
export interface AssistedQuote {
  canPlace: boolean;
  issues: { variantId: string; issues: QuoteIssue[] }[];
  items: QuoteLine[];
  coupons: QuoteCoupon[];
  promotions: unknown[];
  /** Con la primera opción de envío y su primera franja. */
  totals: QuoteTotals;
  delivery: QuoteDelivery | null;
}

/** POST /assisted-orders → 201 */
export interface AssistedOrderResult {
  orderId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  channel: 'backoffice';
  sellerId: string;
  total: string;
  totals: Record<string, string>;
  delivery: {
    fulfillmentType: FulfillmentKind;
    shipmentId: string | null;
    trackingToken: string | null;
    zoneId: string | null;
    deliverySlotId: string | null;
  } | null;
  payment: {
    id: string;
    method: AssistedPaymentMethod;
    status: string;
    amount: string;
    expiresAt: string | null;
    clientSecret: string;
    paymentUrl?: string;
    transfer?: { account: string; reference: string; expiresAt: string | null; voucherUploadPath: string };
  };
}

export const STOCK_ISSUE_LABEL: Record<StockIssueCode, [string, Tone]> = {
  INSUFFICIENT_STOCK: ['Stock insuficiente', 'warn'],
  OUT_OF_STOCK: ['Agotado', 'danger'],
  UNAVAILABLE: ['No disponible', 'danger'],
};

/** Motivos por los que se ofrece courier en lugar de motorizado. */
export const COURIER_REASON_LABEL: Record<string, string> = {
  OUT_OF_ZONE: 'La dirección está fuera de las zonas de motorizado.',
  ZONE_WAREHOUSE_UNAVAILABLE: 'La bodega de la zona no está disponible.',
};

// ---------------------------------------------------------------- Identificación (SRI)

const onlyDigits = (s: string) => /^\d+$/.test(s);

/** Cédula ecuatoriana: 10 dígitos, provincia 01-24 o 30, tercer dígito < 6 y dígito verificador módulo 10. */
export function isValidCedula(raw: string): boolean {
  const s = raw.trim();
  if (s.length !== 10 || !onlyDigits(s)) return false;
  const province = Number(s.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) return false;
  if (Number(s[2]) >= 6) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(s[i]) * (i % 2 === 0 ? 2 : 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(s[9]);
}

function mod11(digits: string, coefficients: number[]): number {
  const sum = coefficients.reduce((acc, c, i) => acc + c * Number(digits[i]), 0);
  const r = 11 - (sum % 11);
  return r === 11 ? 0 : r;
}

/**
 * RUC ecuatoriano (13 dígitos) según el tercer dígito:
 *  - 0-5 persona natural: los 10 primeros son una cédula válida (módulo 10) y el establecimiento ≠ 000;
 *  - 6 entidad pública: verificador en la posición 9 (módulo 11) y establecimiento de 4 dígitos ≠ 0000;
 *  - 9 sociedad privada: verificador en la posición 10 (módulo 11) y establecimiento ≠ 000.
 */
export function isValidRuc(raw: string): boolean {
  const s = raw.trim();
  if (s.length !== 13 || !onlyDigits(s)) return false;
  const province = Number(s.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) return false;
  const third = Number(s[2]);
  if (third < 6) return isValidCedula(s.slice(0, 10)) && s.slice(10) !== '000';
  if (third === 6) {
    const check = mod11(s, [3, 2, 7, 6, 5, 4, 3, 2]);
    return check !== 10 && check === Number(s[8]) && s.slice(9) !== '0000';
  }
  if (third === 9) {
    const check = mod11(s, [4, 3, 2, 7, 6, 5, 4, 3, 2]);
    return check !== 10 && check === Number(s[9]) && s.slice(10) !== '000';
  }
  return false;
}

/** Mensaje de error para un número de identificación según su tipo; null si es válido. */
export function idNumberError(idType: IdType, raw: string): string | null {
  const s = raw.trim();
  if (!s) return 'Ingresa el número de identificación.';
  if (idType === '05') return isValidCedula(s) ? null : 'La cédula no es válida (10 dígitos con dígito verificador).';
  if (idType === '04') return isValidRuc(s) ? null : 'El RUC no es válido (13 dígitos con dígito verificador).';
  return /^[A-Za-z0-9]{5,20}$/.test(s) ? null : 'El pasaporte debe tener de 5 a 20 letras y números.';
}

// ---------------------------------------------------------------- Teléfono

/**
 * Normaliza un teléfono a E.164 (+593…). Acepta "099 123 4567", "02-234-5678", "593991234567" o
 * "+593991234567"; otros números internacionales con "+" se dejan tal cual. null si no es válido.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const plus = trimmed.startsWith('+') || trimmed.startsWith('00');
  let digits = trimmed.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!onlyDigits(digits)) return null;
  if (trimmed.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('593')) {
    const national = digits.slice(3);
    // Móvil 9XXXXXXXX (9 dígitos) o fijo [2-7]XXXXXXX (8 dígitos).
    return /^(9\d{8}|[2-7]\d{7})$/.test(national) ? `+593${national}` : null;
  }
  if (!plus && digits.startsWith('0')) {
    const national = digits.slice(1);
    return /^(9\d{8}|[2-7]\d{7})$/.test(national) ? `+593${national}` : null;
  }
  if (plus && /^\d{7,15}$/.test(digits)) return `+${digits}`;
  return null;
}

// ---------------------------------------------------------------- Estado del asistente

export interface CartLine {
  variantId: string;
  sku: string;
  productName: string;
  color: string | null;
  size: string | null;
  price: string;
  quantity: number;
}

export interface GuestForm {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  idType: IdType | '';
  idNumber: string;
}

export interface AddressForm {
  mainStreet: string;
  secondaryStreet: string;
  number: string;
  reference: string;
  neighborhood: string;
  city: string;
  province: string;
}

export interface BillingForm {
  name: string;
  idType: IdType;
  idNumber: string;
  email: string;
  address: string;
}

export interface AssistedDraft {
  step: number;
  customerMode: 'registered' | 'guest';
  customer: AssistedCustomer | null;
  guest: GuestForm;
  cart: CartLine[];
  fulfillmentType: FulfillmentKind;
  addressMode: 'saved' | 'new';
  addressId: string | null;
  address: AddressForm;
  /** Punto en el mapa (dirección nueva o guardada sin ubicación). */
  pin: { lat: number; lng: number } | null;
  pickupWarehouseId: string | null;
  /** Opción elegida por su clave estable (el quoteId cambia en cada cotización). */
  optionKey: string | null;
  slotId: string | null;
  couponCode: string;
  paymentMethod: AssistedPaymentMethod;
  billingMode: 'final' | 'id';
  billing: BillingForm;
  notes: string;
}

export const MAX_LINES = 50;
export const MAX_QTY = 20;

export function emptyDraft(): AssistedDraft {
  return {
    step: 0,
    customerMode: 'registered',
    customer: null,
    guest: { email: '', firstName: '', lastName: '', phone: '', idType: '', idNumber: '' },
    cart: [],
    fulfillmentType: 'rider',
    addressMode: 'new',
    addressId: null,
    address: { mainStreet: '', secondaryStreet: '', number: '', reference: '', neighborhood: '', city: 'Quito', province: 'Pichincha' },
    pin: null,
    pickupWarehouseId: null,
    optionKey: null,
    slotId: null,
    couponCode: '',
    paymentMethod: 'transfer',
    billingMode: 'final',
    billing: { name: '', idType: '05', idNumber: '', email: '', address: '' },
    notes: '',
  };
}

// ---------------------------------------------------------------- Carrito local

export type AddResult = { cart: CartLine[]; error: string | null };

/** Agrega una unidad de la variante (o suma a su línea). Respeta 20 unidades por línea y 50 líneas. */
export function addToCart(cart: CartLine[], v: VariantLookupItem): AddResult {
  const existing = cart.find((l) => l.variantId === v.variantId);
  if (existing) {
    if (existing.quantity >= MAX_QTY) return { cart, error: `Máximo ${MAX_QTY} unidades por prenda.` };
    return { cart: cart.map((l) => (l.variantId === v.variantId ? { ...l, quantity: l.quantity + 1 } : l)), error: null };
  }
  if (cart.length >= MAX_LINES) return { cart, error: `Máximo ${MAX_LINES} prendas distintas por pedido.` };
  const line: CartLine = {
    variantId: v.variantId,
    sku: v.sku,
    productName: v.productName,
    color: v.color,
    size: v.size,
    price: v.price,
    quantity: 1,
  };
  return { cart: [...cart, line], error: null };
}

/** Cambia la cantidad (1..20); 0 o menos quita la línea. */
export function setLineQuantity(cart: CartLine[], variantId: string, qty: number): CartLine[] {
  if (!Number.isFinite(qty) || qty <= 0) return cart.filter((l) => l.variantId !== variantId);
  const q = Math.min(MAX_QTY, Math.floor(qty));
  return cart.map((l) => (l.variantId === variantId ? { ...l, quantity: q } : l));
}

export function cartUnits(cart: CartLine[]): number {
  return cart.reduce((n, l) => n + l.quantity, 0);
}

// ---------------------------------------------------------------- Validaciones por paso

export function guestErrors(g: GuestForm): Partial<Record<keyof GuestForm, string>> {
  const e: Partial<Record<keyof GuestForm, string>> = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g.email.trim())) e.email = 'Ingresa un email válido.';
  if (!g.firstName.trim()) e.firstName = 'Ingresa el nombre.';
  if (!g.lastName.trim()) e.lastName = 'Ingresa el apellido.';
  if (!normalizePhone(g.phone)) e.phone = 'Teléfono no válido (p. ej. 0991234567).';
  if (g.idType) {
    const err = idNumberError(g.idType, g.idNumber);
    if (err) e.idNumber = err;
  }
  return e;
}

/** Cliente para el API, o null si falta elegirlo o el invitado tiene errores. */
export function customerRef(d: AssistedDraft): { userId: string } | { guest: Record<string, string> } | null {
  if (d.customerMode === 'registered') {
    return d.customer && d.customer.status !== 'blocked' ? { userId: d.customer.userId } : null;
  }
  if (Object.keys(guestErrors(d.guest)).length > 0) return null;
  const g = d.guest;
  const guest: Record<string, string> = {
    email: g.email.trim().toLowerCase(),
    firstName: g.firstName.trim(),
    lastName: g.lastName.trim(),
    phone: normalizePhone(g.phone)!,
  };
  if (g.idType) {
    guest.idType = g.idType;
    guest.idNumber = g.idNumber.trim();
  }
  return { guest };
}

export function selectedSavedAddress(d: AssistedDraft): CustomerAddress | null {
  if (d.customerMode !== 'registered' || d.addressMode !== 'saved' || !d.addressId) return null;
  return d.customer?.addresses.find((a) => a.addressId === d.addressId) ?? null;
}

function trimmedAddress(a: Partial<AddressForm> & { mainStreet: string; city: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t) out[k] = t;
  }
  return out;
}

export interface FulfillmentBody {
  type: FulfillmentKind;
  address?: Record<string, string>;
  location?: { lat: number; lng: number };
  addressId?: string;
  pickupWarehouseId?: string;
}

/**
 * Entrega para el API, o el motivo por el que falta algo. Motorizado y courier necesitan un punto
 * en el mapa: una dirección guardada con ubicación va por addressId; una guardada SIN ubicación se
 * manda copiada con el pin que fijó el vendedor.
 */
export function fulfillmentBody(d: AssistedDraft): { value: FulfillmentBody } | { missing: string } {
  if (d.fulfillmentType === 'pickup') {
    return d.pickupWarehouseId ? { value: { type: 'pickup', pickupWarehouseId: d.pickupWarehouseId } } : { missing: 'Elige la tienda de retiro.' };
  }
  const saved = selectedSavedAddress(d);
  if (saved) {
    if (saved.lat !== null && saved.lng !== null) return { value: { type: d.fulfillmentType, addressId: saved.addressId } };
    if (!d.pin) return { missing: 'Esta dirección no tiene ubicación: fija el pin en el mapa.' };
    return {
      value: {
        type: d.fulfillmentType,
        address: trimmedAddress({
          mainStreet: saved.mainStreet,
          secondaryStreet: saved.secondaryStreet ?? '',
          number: saved.number ?? '',
          reference: saved.reference ?? '',
          neighborhood: saved.neighborhood ?? '',
          city: saved.city,
          province: saved.province,
        }),
        location: d.pin,
      },
    };
  }
  const a = d.address;
  if (a.mainStreet.trim().length < 2) return { missing: 'Escribe la calle principal.' };
  if (a.city.trim().length < 2) return { missing: 'Escribe la ciudad.' };
  if (!d.pin) return { missing: 'Fija el pin de la dirección en el mapa.' };
  return { value: { type: d.fulfillmentType, address: trimmedAddress(a), location: d.pin } };
}

export interface QuoteBody {
  items: { variantId: string; quantity: number }[];
  couponCode?: string;
  customer?: NonNullable<ReturnType<typeof customerRef>>;
  fulfillment: FulfillmentBody;
}

/**
 * Cuerpo de POST /assisted-orders/quote. Si la entrega aún está incompleta y hay una tienda de
 * retiro, se cotiza como retiro (`provisional`) solo para ver stock y totales de la mercadería.
 */
export function buildQuoteBody(d: AssistedDraft, fallbackPickupId?: string | null): { body: QuoteBody; provisional: boolean } | null {
  if (d.cart.length === 0) return null;
  const f = fulfillmentBody(d);
  let fulfillment: FulfillmentBody;
  let provisional = false;
  if ('value' in f) fulfillment = f.value;
  else if (fallbackPickupId) {
    fulfillment = { type: 'pickup', pickupWarehouseId: fallbackPickupId };
    provisional = true;
  } else return null;
  const body: QuoteBody = { items: d.cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), fulfillment };
  const coupon = d.couponCode.trim().toUpperCase();
  if (coupon.length >= 2) body.couponCode = coupon;
  const customer = customerRef(d);
  if (customer) body.customer = customer;
  return { body, provisional };
}

/** Clave estable de una opción de envío (el quoteId es un token nuevo en cada cotización). */
export function optionKey(o: Pick<QuoteOption, 'type' | 'label' | 'courier' | 'service'>): string {
  return [o.type, o.courier?.code ?? '', o.service?.code ?? '', o.label].join('|');
}

export interface Selection {
  option: QuoteOption | null;
  slot: QuoteSlot | null;
  /** Totales de lo elegido (envío y total de la opción/franja). */
  totals: QuoteTotals;
  /** Falta elegir opción o franja. */
  missing: string | null;
}

/** Opción y franja elegidas en la cotización y los totales que les corresponden. */
export function resolveSelection(quote: AssistedQuote, d: Pick<AssistedDraft, 'optionKey' | 'slotId' | 'fulfillmentType'>): Selection {
  if (d.fulfillmentType === 'pickup' || !quote.delivery) {
    return { option: null, slot: null, totals: quote.totals, missing: null };
  }
  const options = quote.delivery.options;
  if (options.length === 0) return { option: null, slot: null, totals: quote.totals, missing: 'No hay opciones de envío para esta dirección.' };
  const option = options.find((o) => optionKey(o) === d.optionKey) ?? null;
  if (!option) return { option: null, slot: null, totals: quote.totals, missing: 'Elige una opción de envío.' };
  if (option.slots && option.slots.length > 0) {
    const slot = option.slots.find((s) => s.slotId === d.slotId) ?? null;
    if (!slot) return { option, slot: null, totals: { ...quote.totals, shippingTotal: option.shippingTotal, total: option.total }, missing: 'Elige la franja de entrega.' };
    return { option, slot, totals: { ...quote.totals, shippingTotal: slot.shippingTotal, total: slot.total }, missing: null };
  }
  return { option, slot: null, totals: { ...quote.totals, shippingTotal: option.shippingTotal, total: option.total }, missing: null };
}

/**
 * Selección efectiva: la que eligió el vendedor si sigue en la cotización; si no, la primera
 * opción y su primera franja (a la que corresponden `totals`). Así no hace falta un efecto que
 * corrija el estado cada vez que llega una cotización nueva.
 */
export function effectiveSelection(
  quote: AssistedQuote | undefined,
  d: Pick<AssistedDraft, 'optionKey' | 'slotId'>,
): Pick<AssistedDraft, 'optionKey' | 'slotId'> {
  const options = quote?.delivery?.options ?? [];
  if (options.length === 0) return { optionKey: d.optionKey, slotId: d.slotId };
  const option = options.find((o) => optionKey(o) === d.optionKey) ?? options[0];
  const slots = option.slots ?? [];
  const slot = slots.find((s) => s.slotId === d.slotId) ?? slots[0] ?? null;
  return { optionKey: optionKey(option), slotId: slot?.slotId ?? null };
}

/** "49" / 49.5 → "49.00" / "49.50" (expectedTotal del DTO). */
export function moneyString(v: string | number): string {
  const n = toNumber(v) ?? 0;
  return n.toFixed(2);
}

export function billingErrors(b: BillingForm): Partial<Record<keyof BillingForm, string>> {
  const e: Partial<Record<keyof BillingForm, string>> = {};
  if (b.name.trim().length < 2) e.name = 'Ingresa el nombre o razón social.';
  const idErr = idNumberError(b.idType, b.idNumber);
  if (idErr) e.idNumber = idErr;
  if (b.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim())) e.email = 'Email no válido.';
  if (b.address.length > 300) e.address = 'Máximo 300 caracteres.';
  return e;
}

export interface CreateBody extends Omit<QuoteBody, 'customer' | 'fulfillment'> {
  customer: NonNullable<ReturnType<typeof customerRef>>;
  fulfillment: FulfillmentBody & { quoteToken?: string; slotId?: string };
  paymentMethod: AssistedPaymentMethod;
  billing?: { name: string; idType: IdType; idNumber: string; email?: string; address?: string };
  notes?: string;
  expectedTotal: string;
}

/**
 * Cuerpo de POST /assisted-orders a partir del borrador y de la ÚLTIMA cotización (hecha con el
 * mismo cliente). El tipo de entrega es el de la opción elegida: la cotización puede ofrecer
 * courier aunque se pidió motorizado (dirección fuera de zona).
 */
export function buildCreateBody(d: AssistedDraft, quote: AssistedQuote): { body: CreateBody } | { error: string } {
  const customer = customerRef(d);
  if (!customer) return { error: 'Completa los datos del cliente.' };
  if (d.cart.length === 0) return { error: 'Agrega al menos una prenda.' };
  if (!quote.canPlace) return { error: 'Hay prendas sin stock suficiente: ajusta el carrito.' };
  const f = fulfillmentBody(d);
  if ('missing' in f) return { error: f.missing };
  const sel = resolveSelection(quote, d);
  if (sel.missing) return { error: sel.missing };
  if (d.fulfillmentType !== 'pickup' && !sel.option) return { error: 'Falta cotizar el envío.' };
  if (d.billingMode === 'id' && Object.keys(billingErrors(d.billing)).length > 0) return { error: 'Revisa los datos de facturación.' };
  if (d.notes.length > 500) return { error: 'Las notas admiten hasta 500 caracteres.' };

  const fulfillment: CreateBody['fulfillment'] = { ...f.value };
  if (sel.option) {
    fulfillment.type = sel.option.type;
    fulfillment.quoteToken = sel.option.quoteId;
    if (sel.slot) fulfillment.slotId = sel.slot.slotId;
  }
  const body: CreateBody = {
    customer,
    items: d.cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    fulfillment,
    paymentMethod: d.paymentMethod,
    expectedTotal: moneyString(sel.totals.total),
  };
  const coupon = d.couponCode.trim().toUpperCase();
  if (coupon.length >= 2) body.couponCode = coupon;
  if (d.billingMode === 'id') {
    const b = d.billing;
    body.billing = { name: b.name.trim(), idType: b.idType, idNumber: b.idNumber.trim() };
    if (b.email.trim()) body.billing.email = b.email.trim();
    if (b.address.trim()) body.billing.address = b.address.trim();
  }
  if (d.notes.trim()) body.notes = d.notes.trim();
  return { body };
}

/** Avisos de stock de una línea en la cotización. */
export function issuesFor(quote: AssistedQuote | undefined, variantId: string): QuoteIssue[] {
  return quote?.issues.find((i) => i.variantId === variantId)?.issues ?? [];
}

/** Errores de la creación que se resuelven volviendo a cotizar. */
export const REQUOTE_CODES: ReadonlySet<string> = new Set([
  'CHECKOUT_TOTAL_CHANGED',
  'CART_NOT_READY',
  'DELIVERY_QUOTE_REQUIRED',
  'DELIVERY_QUOTE_EXPIRED',
  'DELIVERY_QUOTE_INVALID',
  'DELIVERY_QUOTE_MISMATCH',
  'DELIVERY_SLOT_FULL',
  'PICKUP_WAREHOUSE_REQUIRED',
]);

// ---------------------------------------------------------------- Mensajes al cliente

/** Teléfono del cliente del borrador en E.164 (para WhatsApp), si lo hay. */
export function customerPhone(d: AssistedDraft): string | null {
  const raw = d.customerMode === 'registered' ? (d.customer?.phone ?? '') : d.guest.phone;
  return raw ? normalizePhone(raw) : null;
}

export function customerFirstName(d: AssistedDraft): string {
  return (d.customerMode === 'registered' ? d.customer?.firstName : d.guest.firstName)?.trim() || '';
}

/** https://wa.me/593991234567?text=… (sin "+"); sin teléfono abre WhatsApp para elegir el contacto. */
export function whatsappUrl(phoneE164: string | null, text: string): string {
  const digits = phoneE164 ? phoneE164.replace(/\D/g, '') : '';
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/**
 * Mensaje en español para el cliente con el número de pedido, el total y lo que debe hacer para
 * pagar. `formatMoney`/`formatDate` se inyectan para mantener la función pura y probable.
 */
export function paymentMessage(
  r: AssistedOrderResult,
  opts: { name?: string; trackingUrl?: string | null; money: (v: string) => string; dateTime: (v: string) => string },
): string {
  const lines: string[] = [];
  lines.push(`Hola${opts.name ? ` ${opts.name}` : ''}, tu pedido ${r.orderNumber} por ${opts.money(r.total)} fue registrado.`);
  const p = r.payment;
  if (p.method === 'card_link' && p.paymentUrl) {
    lines.push(`Puedes pagarlo con tarjeta en este enlace: ${p.paymentUrl}`);
    if (p.expiresAt) lines.push(`El enlace vence el ${opts.dateTime(p.expiresAt)}.`);
  } else if (p.method === 'transfer' && p.transfer) {
    lines.push(`Para pagar por transferencia usa estos datos:`);
    lines.push(`Cuenta: ${p.transfer.account}`);
    lines.push(`Referencia: ${p.transfer.reference}`);
    lines.push(`Monto: ${opts.money(p.amount)}`);
    const exp = p.transfer.expiresAt ?? p.expiresAt;
    if (exp) lines.push(`Realiza la transferencia antes del ${opts.dateTime(exp)} y envíanos el comprobante por este medio.`);
  } else if (p.method === 'cod') {
    lines.push(`Pagas ${opts.money(r.total)} al recibir tu pedido.`);
  }
  if (opts.trackingUrl) lines.push(`Sigue tu pedido aquí: ${opts.trackingUrl}`);
  lines.push('¡Gracias por tu compra!');
  return lines.join('\n');
}

// ---------------------------------------------------------------- Comprobante de transferencia

/** POST /assisted-orders/:orderId/transfer-voucher: JPG, PNG o PDF de hasta 5 MB. */
export const VOUCHER_MAX_BYTES = 5 * 1024 * 1024;
export const VOUCHER_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;

export function voucherFileError(file: { type: string; size: number } | null | undefined): string | null {
  if (!file) return 'Elige el archivo del comprobante.';
  if (!(VOUCHER_TYPES as readonly string[]).includes(file.type)) return 'El comprobante debe ser JPG, PNG o PDF.';
  if (file.size === 0) return 'El archivo está vacío.';
  if (file.size > VOUCHER_MAX_BYTES) return 'El comprobante supera los 5 MB.';
  return null;
}

/** Pedidos a los que se les puede subir comprobante: transferencia con el pago pendiente. */
export function canUploadVoucher(o: { paymentMethod: string; paymentStatus: string; status: string }): boolean {
  return o.paymentMethod === 'transfer' && o.paymentStatus === 'pending' && o.status !== 'cancelled';
}

// ---------------------------------------------------------------- Borrador en sessionStorage

export const DRAFT_STORAGE_KEY = 'bo.ventas.assisted.draft.v1';

/** Lee el borrador guardado; cualquier problema (sin storage, JSON roto) devuelve null. */
export function parseDraft(raw: string | null): AssistedDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<AssistedDraft>;
    if (!d || typeof d !== 'object' || !Array.isArray(d.cart)) return null;
    const base = emptyDraft();
    return {
      ...base,
      ...d,
      guest: { ...base.guest, ...d.guest },
      address: { ...base.address, ...d.address },
      billing: { ...base.billing, ...d.billing },
      step: Math.min(4, Math.max(0, Number(d.step) || 0)),
    };
  } catch {
    return null;
  }
}
