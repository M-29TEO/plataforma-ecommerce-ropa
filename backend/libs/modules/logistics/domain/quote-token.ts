import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeliveryQuoteExpiredError, DeliveryQuoteInvalidError } from './errors';

/**
 * Opción de envío firmada (el `quoteId` que el checkout devuelve al pagar).
 *
 * La tarifa del motorizado depende de la distancia OSRM de ese momento: si se recalculara al
 * pagar, un OSRM caído entre la cotización y el pago cambiaría el precio. Por eso la opción
 * cotizada viaja firmada con HMAC y vence en DELIVERY_QUOTE_TTL_MINUTES, sin tablas nuevas
 * (courier_quotes exige un courier_service_id y no sirve para el motorizado). Para el courier, además,
 * la fila de courier_quotes queda como registro y se marca `selected` al comprar.
 *
 * La firma cubre el destino, el peso y el total de la mercadería: si el cliente cambia el
 * carrito o la dirección después de cotizar, el checkout responde 409 y pide cotizar de nuevo.
 */
export interface DeliveryOptionClaims {
  v: 1;
  /** Tenant. */
  tid: string;
  typ: 'rider' | 'courier';
  /** Zona propia (rider; en courier, la zona 'courier' si el punto cae en una). */
  zid: string | null;
  /** Bodega de origen usada para cotizar. */
  wid: string;
  /** courier_quotes.id y courier_service_id (solo courier). */
  cq: string | null;
  csid: string | null;
  /** Precio en centavos, IVA incluido, SIN el recargo de la franja. */
  p: number;
  /** Costo del courier (centavos) o null. */
  cost: number | null;
  /** Distancia en metros y de dónde salió. */
  dm: number | null;
  ds: 'osrm' | 'straight_line' | null;
  eta: number | null;
  lat: number;
  lng: number;
  w: number;
  vol: number;
  /** Total de la mercadería en centavos (envío gratis por umbral). */
  mt: number;
  /** Vencimiento, segundos Unix. */
  exp: number;
}

const b64 = (buf: Buffer) => buf.toString('base64url');

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function signDeliveryOption(secret: string, claims: DeliveryOptionClaims): string {
  const payload = b64(Buffer.from(JSON.stringify(claims)));
  return `${payload}.${b64(mac(secret, payload))}`;
}

export function verifyDeliveryOption(secret: string, token: string, now: Date): DeliveryOptionClaims {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) throw new DeliveryQuoteInvalidError();
  const expected = mac(secret, payload);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new DeliveryQuoteInvalidError();
  let claims: DeliveryOptionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DeliveryOptionClaims;
  } catch {
    throw new DeliveryQuoteInvalidError();
  }
  if (claims.v !== 1) throw new DeliveryQuoteInvalidError();
  if (claims.exp * 1000 <= now.getTime()) throw new DeliveryQuoteExpiredError();
  return claims;
}
