/**
 * Tipos compartidos de las respuestas del API que usa más de una pantalla. Los tipos propios de
 * cada área viven junto a ella (lib/<area>.ts).
 */

export type UserType = 'customer' | 'staff' | 'rider';

/** GET /v1/me */
export interface UserProfile {
  id: string;
  tenantId: string;
  type: UserType;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  locale: string;
  status: 'pending' | 'active' | 'blocked' | 'anonymized';
  emailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: string;
}

/** Respuesta del login cuando falta el segundo factor. */
export interface MfaChallenge {
  mfaRequired?: true;
  mfaSetupRequired?: true;
  mfaToken: string;
  expiresIn: number;
}

/** Alta del 2FA: secreto en base32, URI otpauth y QR como data URL (PNG). */
export interface MfaEnrollment {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
}

/** Página de un listado: `{ items, total }`. */
export interface Page<T> {
  items: T[];
  total: number;
}

/** Monto tal como lo devuelve el API (numeric(12,2) como string, o número). */
export type Money = string | number;
