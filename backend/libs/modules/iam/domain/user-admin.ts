import { randomInt } from 'node:crypto';
import { ConflictError, ValidationError } from '../../../shared-kernel';
import { assertPasswordPolicy } from './password-policy';
import { UserStatus } from './user-account';

/** Reglas de la gestión de usuarios del backoffice (las aplica UserAdminService). */

/** Longitud de la contraseña temporal: 20 caracteres de 57 posibles ≈ 116 bits de entropía. */
export const TEMPORARY_PASSWORD_LENGTH = 20;
/** Sin caracteres que se confunden al dictarla o copiarla a mano (0/O, 1/l/I). */
export const TEMPORARY_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * Contraseña temporal que el admin entrega al usuario (alta o reseteo). Generada con el CSPRNG
 * del sistema (crypto.randomInt, sin sesgo de módulo) y validada contra la política de contraseñas.
 * `pick` solo se inyecta en los tests.
 */
export function generateTemporaryPassword(pick: (max: number) => number = randomInt): string {
  let password = '';
  for (let i = 0; i < TEMPORARY_PASSWORD_LENGTH; i++) password += TEMPORARY_PASSWORD_ALPHABET[pick(TEMPORARY_PASSWORD_ALPHABET.length)];
  assertPasswordPolicy(password);
  return password;
}

export type StatusChange = 'block' | 'unblock';

/**
 * Bloquear o desbloquear solo aplica a cuentas activas o bloqueadas: una pendiente aún no se usa
 * y una anonimizada (LOPDP) ya no tiene datos que reactivar. Devuelve false si ya estaba en el
 * estado pedido (operación idempotente, sin auditoría).
 */
export function planStatusChange(current: UserStatus, change: StatusChange): boolean {
  assertManageable(current);
  return change === 'block' ? current === 'active' : current === 'blocked';
}

/** Las acciones del admin sobre una cuenta (bloqueo, reseteo de contraseña) exigen que siga viva. */
export function assertManageable(status: UserStatus): void {
  if (status !== 'active' && status !== 'blocked') {
    throw new ValidationError('USER_STATUS_NOT_MANAGEABLE', `No se puede gestionar una cuenta en estado ${status}`, { status });
  }
}

/**
 * Misma regla que al quitar el rol admin: el tenant nunca se queda sin un administrador activo.
 * otherActiveAdmins = admins activos sin contar al que se bloquea.
 */
export function assertCanBlock(targetIsAdmin: boolean, otherActiveAdmins: number): void {
  if (targetIsAdmin && otherActiveAdmins < 1) {
    throw new ConflictError('LAST_ADMIN', 'No se puede bloquear al último administrador activo');
  }
}

/** Escapa los comodines de LIKE/ILIKE (%, _ y \) para buscar el texto literal. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
