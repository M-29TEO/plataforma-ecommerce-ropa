import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { LockedError, sniffFileType, toCents, ValidationError } from '../../../shared-kernel';

/**
 * Prueba de entrega (logistics.delivery_proofs): foto del paquete entregado, firma de quien recibe
 * y código de entrega (OTP) de 4 dígitos que el cliente ve en su seguimiento.
 *
 * El código se DERIVA del id del envío con un HMAC (DELIVERY_OTP_SECRET): el servidor lo puede
 * mostrar al cliente en cualquier momento sin guardarlo en claro. En el envío solo queda su hash
 * (shipments.otp_hash, SHA-256), que se fija al retirar el paquete. Con 4 dígitos la fuerza bruta
 * es trivial, así que se limita: OTP_MAX_FAILURES intentos fallidos en OTP_FAILURE_WINDOW_MS por
 * envío (cada fallo queda como fila 'otp' con otp_verified = false) y después 423 OTP_LOCKED.
 */
export const OTP_MAX_FAILURES = 5;
export const OTP_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/** Estados en que el cliente ve el código: el motorizado lleva el paquete. */
export const DELIVERY_CODE_STATUSES = ['picked_up', 'in_transit', 'arriving', 'failed_attempt'] as const;

export function deliveryOtpCode(secret: string, shipmentId: string): string {
  const mac = createHmac('sha256', secret).update(`delivery-otp:${shipmentId}`).digest();
  return String(mac.readUInt32BE(0) % 10_000).padStart(4, '0');
}

export function otpHash(code: string): Buffer {
  return createHash('sha256').update(code, 'utf8').digest();
}

export function otpMatches(code: string, hash: Buffer): boolean {
  const candidate = otpHash(code);
  return candidate.length === hash.length && timingSafeEqual(candidate, hash);
}

/** El cliente ve el código solo con motorizado y mientras el paquete va en camino. */
export function showsDeliveryCode(s: { carrierType: string; status: string }): boolean {
  return s.carrierType === 'rider' && (DELIVERY_CODE_STATUSES as readonly string[]).includes(s.status);
}

/** Intentos que quedan antes del bloqueo; lanza OTP_LOCKED si ya no queda ninguno. */
export function assertOtpNotLocked(recentFailures: number): number {
  if (recentFailures >= OTP_MAX_FAILURES) throw new OtpLockedError();
  return OTP_MAX_FAILURES - recentFailures;
}

export class OtpLockedError extends LockedError {
  constructor() {
    super('OTP_LOCKED', `Demasiados códigos incorrectos: espera ${OTP_FAILURE_WINDOW_MS / 60_000} minutos o llama a soporte`, {
      maxFailures: OTP_MAX_FAILURES,
    });
  }
}

export class OtpInvalidError extends ValidationError {
  constructor(attemptsLeft: number) {
    super('OTP_INVALID', 'El código de entrega no es correcto', { attemptsLeft });
  }
}

export class OtpRequiredError extends ValidationError {
  constructor() {
    super('OTP_REQUIRED', 'Pide al cliente el código de entrega de 4 dígitos (lo ve en su seguimiento)');
  }
}

// ---------------------------------------------------------------- Archivos de la prueba

export const PROOF_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PROOF_SIGNATURE_MAX_BYTES = 1024 * 1024;

export interface ProofFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export type ProofKind = 'photo' | 'signature';

const PROOF_RULES: Record<ProofKind, { types: readonly string[]; maxBytes: number; label: string; code: string }> = {
  photo: { types: ['image/jpeg', 'image/png'], maxBytes: PROOF_PHOTO_MAX_BYTES, label: 'La foto de la entrega', code: 'PROOF_PHOTO' },
  signature: { types: ['image/png'], maxBytes: PROOF_SIGNATURE_MAX_BYTES, label: 'La firma', code: 'PROOF_SIGNATURE' },
};

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png' };

/**
 * Valida un archivo de la prueba: obligatorio, tamaño y tipo REAL por magic bytes (el Content-Type
 * del multipart lo elige el cliente). Devuelve el tipo detectado y la extensión para la clave.
 */
export function validateProofFile(kind: ProofKind, file: ProofFile | undefined): { contentType: string; ext: string } {
  const rule = PROOF_RULES[kind];
  if (!file || file.size === 0 || file.buffer.length === 0) {
    throw new ValidationError(`${rule.code}_REQUIRED`, `${rule.label} es obligatoria (campo "${kind}")`);
  }
  if (file.size > rule.maxBytes || file.buffer.length > rule.maxBytes) {
    throw new ValidationError(`${rule.code}_TOO_LARGE`, `${rule.label} supera ${rule.maxBytes / 1024 / 1024} MB`, { maxBytes: rule.maxBytes });
  }
  const sniffed = sniffFileType(file.buffer);
  if (!sniffed || !rule.types.includes(sniffed)) {
    throw new ValidationError(`${rule.code}_TYPE`, `${rule.label} debe ser ${rule.types.map((t) => EXT[t].toUpperCase()).join(' o ')}`, {
      allowed: rule.types,
    });
  }
  return { contentType: sniffed, ext: EXT[sniffed] };
}

// ---------------------------------------------------------------- Cobro contra entrega

export const COD_METHODS = ['cash', 'card_pos', 'deuna_qr'] as const;
export type CodMethod = (typeof COD_METHODS)[number];

/**
 * Lo cobrado debe ser exactamente el monto contra entrega del envío (sin vuelto ni cobros parciales:
 * una diferencia se resuelve con soporte, no en la app). Sin contra entrega, no se cobra nada.
 */
export function assertCodCollected(codAmount: string, collected: string | undefined): void {
  const expected = toCents(codAmount);
  if (expected === 0 && (collected === undefined || toCents(collected) === 0)) return;
  if (collected === undefined || toCents(collected) !== expected) {
    throw new ValidationError('COD_AMOUNT_MISMATCH', `Debes cobrar exactamente ${codAmount} USD`, {
      expected: codAmount,
      received: collected ?? null,
    });
  }
}
