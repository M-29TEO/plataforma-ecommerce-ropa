import { Injectable } from '@nestjs/common';
import { Database, DomainError, LockedError, Queryable, UnauthenticatedError } from '../../../shared-kernel';
import { AFTER_SUCCESSFUL_LOGIN, afterFailedLogin, isLocked } from '../domain/user-account';
import { UserAccountRepository } from './ports';

/** Mismo error para email inexistente y contraseña errónea: no revela qué emails están registrados. */
export function invalidCredentials(): UnauthenticatedError {
  return new UnauthenticatedError('INVALID_CREDENTIALS', 'Email o contraseña incorrectos');
}

export function accountLocked(lockedUntil: Date): LockedError {
  return new LockedError('ACCOUNT_LOCKED', 'Cuenta bloqueada temporalmente por intentos fallidos', {
    lockedUntil: lockedUntil.toISOString(),
  });
}

export interface SettleOptions<T> {
  /** ¿La credencial de este intento (contraseña o código TOTP) fue correcta? */
  ok: boolean;
  now: Date;
  /**
   * true: el intento completa el login (reinicia failed_logins y guarda last_login_at). false: es
   * un paso intermedio (contraseña correcta con 2FA pendiente, o una verificación con sesión ya
   * abierta): no reinicia el contador, así no se pueden probar códigos TOTP sin límite
   * intercalando la contraseña correcta.
   */
  completesLogin: boolean;
  /** Error si ok = false (401 en el login, 422 con sesión abierta). */
  invalid: () => DomainError;
  /** Se ejecuta con la fila bloqueada (FOR UPDATE) cuando ok y la cuenta no está bloqueada. */
  onSuccess: (tx: Queryable) => Promise<T>;
}

type Outcome<T> = { kind: 'ok'; value: T } | { kind: 'locked'; lockedUntil: Date } | { kind: 'invalid' };

/**
 * Registro de intentos de autenticación (contraseña y 2FA comparten el contador): al 5.º fallo
 * seguido la cuenta queda bloqueada 15 min. Con la fila bloqueada (FOR UPDATE) vuelve a mirar
 * el bloqueo: dos intentos simultáneos no pierden fallos ni se saltan un bloqueo recién puesto.
 */
@Injectable()
export class LoginAttempts {
  constructor(
    private readonly db: Database,
    private readonly accounts: UserAccountRepository,
  ) {}

  async settle<T>(userId: string, opts: SettleOptions<T>): Promise<T> {
    // El error se lanza fuera de la transacción: lanzar adentro haría ROLLBACK del fallo registrado.
    const outcome = await this.db.withTransaction(async (tx): Promise<Outcome<T>> => {
      const state = await this.accounts.lockLoginState(tx, userId);
      if (isLocked(state, opts.now)) return { kind: 'locked', lockedUntil: state.lockedUntil! };
      if (!opts.ok) {
        const next = afterFailedLogin(state, opts.now);
        await this.accounts.saveLoginState(tx, userId, next);
        return isLocked(next, opts.now) ? { kind: 'locked', lockedUntil: next.lockedUntil! } : { kind: 'invalid' };
      }
      if (opts.completesLogin) await this.accounts.saveLoginState(tx, userId, AFTER_SUCCESSFUL_LOGIN, opts.now);
      return { kind: 'ok', value: await opts.onSuccess(tx) };
    });

    if (outcome.kind === 'locked') throw accountLocked(outcome.lockedUntil);
    if (outcome.kind === 'invalid') throw opts.invalid();
    return outcome.value;
  }
}
