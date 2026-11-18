import { ValidationError } from '../../../shared-kernel';

export const PASSWORD_MIN_LENGTH = 10;
/** Tope para que nadie haga trabajar a argon2 con contraseñas de megabytes (DoS). */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Política de contraseñas (NIST 800-63B): manda la longitud, sin reglas de composición.
 * Se cuentan caracteres Unicode, no unidades UTF-16 (un emoji vale 1).
 */
export function assertPasswordPolicy(password: string): void {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError('PASSWORD_TOO_SHORT', `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`, {
      minLength: PASSWORD_MIN_LENGTH,
    });
  }
  if (length > PASSWORD_MAX_LENGTH) {
    throw new ValidationError('PASSWORD_TOO_LONG', `La contraseña no puede superar ${PASSWORD_MAX_LENGTH} caracteres`, {
      maxLength: PASSWORD_MAX_LENGTH,
    });
  }
}
