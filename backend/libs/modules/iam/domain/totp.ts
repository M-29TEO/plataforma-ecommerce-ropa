import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) sobre HOTP (RFC 4226): HMAC-SHA1, 6 dígitos, pasos de 30 s. Es lo que
 * entienden Google Authenticator, Aegis, FreeOTP o el llavero del teléfono.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Se aceptan el paso actual y uno antes o después (desfase de reloj del teléfono, ±30 s). */
export const TOTP_WINDOW = 1;
/** 160 bits: el tamaño de clave que recomienda RFC 4226 para HMAC-SHA1. */
const SECRET_BYTES = 20;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 RFC 4648 sin relleno (el formato de los secretos en las apps autenticadoras). */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Carácter base32 inválido: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** Número de paso de 30 s para un instante. */
export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP(K, contador) con truncamiento dinámico (RFC 4226 §5.3). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  // RFC 6238/4226 con HMAC-SHA1: lo que implementan las apps autenticadoras. HMAC-SHA1 no está roto
  // (las colisiones de SHA-1 no afectan a un HMAC con clave secreta de 160 bits).
  // nosemgrep: moda-hash-debil
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secret: Buffer, now: Date, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(now), digits);
}

/**
 * Paso que coincide con el código (dentro de la ventana) o null. Devolver el paso permite
 * rechazar que el mismo código se use dos veces (anti-replay).
 */
export function verifyTotp(secret: Buffer, code: string, now: Date): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(now);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const expected = Buffer.from(hotp(secret, current + delta));
    if (timingSafeEqual(expected, Buffer.from(code))) return current + delta;
  }
  return null;
}

/** URI que codifica el QR (formato "Key Uri" de Google Authenticator). */
export function otpauthUri(issuer: string, accountName: string, secret: Buffer): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
