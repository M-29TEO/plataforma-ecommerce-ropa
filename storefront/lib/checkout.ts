import type { DeliveryOption, PaymentMethod } from './commerce-types';

export const PROVINCES = [
  'Azuay', 'Bolívar', 'Cañar', 'Carchi', 'Chimborazo', 'Cotopaxi', 'El Oro', 'Esmeraldas', 'Galápagos', 'Guayas', 'Imbabura', 'Loja',
  'Los Ríos', 'Manabí', 'Morona Santiago', 'Napo', 'Orellana', 'Pastaza', 'Pichincha', 'Santa Elena', 'Santo Domingo de los Tsáchilas',
  'Sucumbíos', 'Tungurahua', 'Zamora Chinchipe',
] as const;

export interface AddressForm {
  mainStreet: string;
  secondaryStreet: string;
  number: string;
  reference: string;
  neighborhood: string;
  city: string;
  province: string;
  lat: number | null;
  lng: number | null;
}

export const emptyAddress = (): AddressForm => ({
  mainStreet: '',
  secondaryStreet: '',
  number: '',
  reference: '',
  neighborhood: '',
  city: 'Quito',
  province: 'Pichincha',
  lat: null,
  lng: null,
});

const opt = (v: string) => (v.trim() ? v.trim() : undefined);

/** Cuerpo de /checkout/delivery-options: el API rechaza campos extra (sin barrio). */
export function quoteAddress(a: AddressForm) {
  return {
    mainStreet: a.mainStreet.trim(),
    secondaryStreet: opt(a.secondaryStreet),
    number: opt(a.number),
    reference: opt(a.reference),
    city: a.city.trim(),
    province: opt(a.province),
    lat: a.lat!,
    lng: a.lng!,
  };
}

/** Dirección del pedido (/checkout): admite barrio (lo usa Reportes). */
export function orderAddress(a: AddressForm) {
  return { ...quoteAddress(a), neighborhood: opt(a.neighborhood) };
}

export function addressReady(a: AddressForm): boolean {
  return a.mainStreet.trim().length >= 2 && a.city.trim().length >= 2 && a.lat !== null && a.lng !== null;
}

/** Precio de la opción de envío elegida: con franja, el de la franja (tarifa + recargo). */
export function deliveryPrice(option: DeliveryOption | undefined, slotId: string | null): string | null {
  if (!option) return null;
  if (option.type === 'rider' && option.slots?.length) {
    const slot = option.slots.find((s) => s.slotId === slotId);
    return slot ? slot.price : null;
  }
  return option.price;
}

/** Total que verá el cliente: el del carrito (con IVA) más el envío; el API lo confirma con expectedTotal. */
export function expectedTotal(cartTotal: string, shipping: string | null, freeShipping: boolean): string | null {
  if (shipping === null) return null;
  const cents = Math.round(Number(cartTotal) * 100) + (freeShipping ? 0 : Math.round(Number(shipping) * 100));
  return (cents / 100).toFixed(2);
}

export const PAYMENT_METHODS: ReadonlyArray<{ value: PaymentMethod; label: string; hint: string; riderOnly?: boolean }> = [
  { value: 'card', label: 'Tarjeta de crédito o débito', hint: 'Visa, Mastercard, Diners (pasarela simulada)' },
  { value: 'deuna', label: 'DeUna', hint: 'Paga desde la app de tu banco' },
  { value: 'pichincha', label: 'Banco Pichincha', hint: 'Botón de pago' },
  { value: 'transfer', label: 'Transferencia bancaria', hint: 'Subes el comprobante; confirmamos en horas hábiles' },
  { value: 'cod', label: 'Pago contra entrega', hint: 'Efectivo al motorizado', riderOnly: true },
];

/** Cédula ecuatoriana: 10 dígitos, provincia 01–24 (o 30), tercer dígito < 6 y dígito verificador módulo 10. */
export function isValidCedula(id: string): boolean {
  if (!/^\d{10}$/.test(id)) return false;
  const province = Number(id.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) return false;
  if (Number(id[2]) >= 6) return false;
  const sum = id
    .slice(0, 9)
    .split('')
    .reduce((acc, d, i) => {
      let n = Number(d) * (i % 2 === 0 ? 2 : 1);
      if (n > 9) n -= 9;
      return acc + n;
    }, 0);
  return (10 - (sum % 10)) % 10 === Number(id[9]);
}

/** RUC: 13 dígitos terminados en 001 (persona natural: cédula válida + 001). Sociedades: lo valida el SRI. */
export function isValidRuc(id: string): boolean {
  if (!/^\d{13}$/.test(id) || !id.endsWith('001')) return false;
  return Number(id[2]) < 6 ? isValidCedula(id.slice(0, 10)) : true;
}

export function idError(idType: '04' | '05' | '06', id: string): string | null {
  if (idType === '05') return isValidCedula(id) ? null : 'La cédula no es válida';
  if (idType === '04') return isValidRuc(id) ? null : 'El RUC no es válido';
  return /^[A-Za-z0-9]{5,20}$/.test(id) ? null : 'El pasaporte debe tener de 5 a 20 letras y números';
}

/** Clave de idempotencia por intento de pago: el mismo cuerpo reintentado no crea otro pedido. */
export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `ck-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Lo que la página de resultado necesita y no puede pedirle al API sin el secreto del pago. */
export interface PendingPayment {
  paymentId: string;
  clientSecret: string;
  orderId: string;
  orderNumber: string;
  trackingToken: string | null;
  total: string;
}

const KEY = (paymentId: string) => `pago:${paymentId}`;

export function savePendingPayment(p: PendingPayment): void {
  try {
    sessionStorage.setItem(KEY(p.paymentId), JSON.stringify(p));
  } catch {
    // Navegación privada sin storage: la página de resultado mostrará un mensaje genérico.
  }
}

export function loadPendingPayment(paymentId: string): PendingPayment | null {
  try {
    const raw = sessionStorage.getItem(KEY(paymentId));
    return raw ? (JSON.parse(raw) as PendingPayment) : null;
  } catch {
    return null;
  }
}
