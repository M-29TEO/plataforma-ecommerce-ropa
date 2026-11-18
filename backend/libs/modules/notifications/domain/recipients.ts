import { createHash } from 'node:crypto';
import { Channel } from './channel';

/**
 * dedupe_key de platform.notifications (UNIQUE por tenant): mismo mensaje, misma fuente, mismo
 * canal y mismo destinatario → una sola fila, aunque el evento llegue dos veces (entrega "al menos
 * una vez" del outbox). El destinatario va como hash: la clave no expone emails ni teléfonos.
 */
export function dedupeKey(templateCode: string, sourceId: string, channel: Channel, recipient: string): string {
  const hash = createHash('sha256').update(recipient.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 24);
  return `${templateCode}:${sourceId}:${channel}:${hash}`;
}

/**
 * Teléfono a E.164 (WhatsApp y SMS). Ecuador por defecto: 09XXXXXXXX (celular) → +5939XXXXXXXX,
 * 0[2-7]XXXXXXX (fijo) → +593[2-7]XXXXXXX, 593… → +593…. Con "+" se respeta el país indicado.
 * null si no parece un número válido.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
  if (/^09\d{8}$/.test(digits)) return `+593${digits.slice(1)}`;
  if (/^0[2-7]\d{7}$/.test(digits)) return `+593${digits.slice(1)}`;
  if (/^593[2-9]\d{7,8}$/.test(digits)) return `+${digits}`;
  return null;
}

/** Celular de Ecuador (+5939…) u otro país: WhatsApp y SMS no van a teléfonos fijos de Ecuador. */
export function isMobile(e164: string): boolean {
  return e164.startsWith('+593') ? /^\+5939\d{8}$/.test(e164) : true;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string | null | undefined): string | null {
  const email = raw?.trim().toLowerCase();
  return email && EMAIL_RE.test(email) ? email : null;
}
