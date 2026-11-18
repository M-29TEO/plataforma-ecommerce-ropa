import { createHmac, timingSafeEqual } from 'node:crypto';
import { ExpiredTicketTokenError, InvalidTicketTokenError } from './errors';

/**
 * Enlace de acceso a UN ticket, firmado con HMAC (mismo esquema que la opción de envío de
 * Logística): lo llevan los emails de soporte para que el cliente, aun siendo invitado, vea el
 * ticket, responda y conteste la encuesta CSAT sin iniciar sesión. Sin tablas: vence a los
 * SUPPORT_LINK_TTL_DAYS y cada email trae uno nuevo.
 */
export interface TicketAccessClaims {
  v: 1;
  tid: string;
  /** support.tickets.id */
  tk: string;
  /** Vencimiento, segundos Unix. */
  exp: number;
}

const b64 = (buf: Buffer) => buf.toString('base64url');

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function signTicketAccess(secret: string, tenantId: string, ticketId: string, ttlDays: number, now = new Date()): string {
  const claims: TicketAccessClaims = { v: 1, tid: tenantId, tk: ticketId, exp: Math.floor(now.getTime() / 1000) + ttlDays * 86_400 };
  const payload = b64(Buffer.from(JSON.stringify(claims)));
  return `${payload}.${b64(mac(secret, payload))}`;
}

export function verifyTicketAccess(secret: string, token: string, now = new Date()): TicketAccessClaims {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) throw new InvalidTicketTokenError();
  const expected = mac(secret, payload);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new InvalidTicketTokenError();
  let claims: TicketAccessClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TicketAccessClaims;
  } catch {
    throw new InvalidTicketTokenError();
  }
  if (claims.v !== 1 || typeof claims.tid !== 'string' || typeof claims.tk !== 'string') throw new InvalidTicketTokenError();
  if (claims.exp * 1000 <= now.getTime()) throw new ExpiredTicketTokenError();
  return claims;
}
