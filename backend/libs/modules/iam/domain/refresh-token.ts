import { createHash, randomBytes } from 'node:crypto';

/**
 * Refresh tokens opacos con rotación: cada uso entrega uno nuevo de la misma familia
 * (family_id = la sesión iniciada con un login) y revoca el anterior. La base guarda solo el
 * SHA-256: quien lea iam.refresh_tokens no puede usar los tokens.
 */

/** 32 bytes aleatorios en base64url (43 caracteres). */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 basta (no argon2): el token tiene 256 bits de entropía, no se puede adivinar por diccionario. */
export function hashRefreshToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export interface StoredRefreshToken {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Qué hacer con un refresh token presentado:
 *  - reused: ya estaba revocado (rotado o cerrado). Si alguien lo presenta otra vez, una copia
 *    anda suelta (robo): se revoca toda la familia, también el token vigente del ladrón o la víctima.
 *  - expired: venció; se revoca y hay que volver a iniciar sesión.
 *  - rotate: válido; se revoca y se emite su sucesor.
 */
export type RefreshDecision = 'rotate' | 'reused' | 'expired';

export function decideRefresh(token: Pick<StoredRefreshToken, 'expiresAt' | 'revokedAt'>, now: Date): RefreshDecision {
  if (token.revokedAt !== null) return 'reused';
  if (token.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'rotate';
}
