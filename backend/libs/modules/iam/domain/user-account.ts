/** Cuenta de usuario de iam.users vista desde la autenticación. */

export type UserType = 'customer' | 'staff' | 'rider';
export type UserStatus = 'pending' | 'active' | 'blocked' | 'anonymized';

/** Intentos fallidos seguidos que bloquean la cuenta. */
export const MAX_FAILED_LOGINS = 5;
/** Duración del bloqueo temporal. */
export const LOCKOUT_MS = 15 * 60 * 1000;

/** Columnas failed_logins y locked_until. */
export interface LoginState {
  failedLogins: number;
  lockedUntil: Date | null;
}

export interface LoginAccount extends LoginState {
  id: string;
  tenantId: string;
  type: UserType;
  status: UserStatus;
  passwordHash: string | null;
  /** 2FA TOTP activado (iam.users.mfa_enabled). */
  mfaEnabled: boolean;
}

export function isLocked(state: LoginState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/**
 * Solo una cuenta activa y con contraseña puede iniciar sesión. Pendiente, bloqueada por el
 * staff o anonimizada (LOPDP): no. Las borradas ni llegan aquí (el repositorio las excluye).
 */
export function canLogIn(account: Pick<LoginAccount, 'status' | 'passwordHash'>): boolean {
  return account.status === 'active' && account.passwordHash !== null;
}

/**
 * Estado tras un intento fallido. Al llegar a MAX_FAILED_LOGINS la cuenta queda bloqueada
 * LOCKOUT_MS y el contador vuelve a 0: al expirar el bloqueo hay otros 5 intentos. Un bloqueo
 * ya vencido se limpia.
 */
export function afterFailedLogin(state: LoginState, now: Date): LoginState {
  const failedLogins = state.failedLogins + 1;
  if (failedLogins >= MAX_FAILED_LOGINS) {
    return { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) };
  }
  return { failedLogins, lockedUntil: isLocked(state, now) ? state.lockedUntil : null };
}

/** Un login correcto borra los fallos acumulados. */
export const AFTER_SUCCESSFUL_LOGIN: LoginState = { failedLogins: 0, lockedUntil: null };

/** Email canónico: sin espacios y en minúsculas (la columna es citext, pero así se guarda limpio). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
