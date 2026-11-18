import { ValidationError } from '../../../shared-kernel';
import { assertPasswordPolicy } from './password-policy';
import { afterFailedLogin, canLogIn, isLocked, LOCKOUT_MS, LoginState, MAX_FAILED_LOGINS, normalizeEmail } from './user-account';

describe('assertPasswordPolicy', () => {
  it('acepta 10 caracteres', () => {
    expect(() => assertPasswordPolicy('a'.repeat(10))).not.toThrow();
  });

  it('rechaza 9 caracteres con PASSWORD_TOO_SHORT', () => {
    expect(() => assertPasswordPolicy('a'.repeat(9))).toThrow(expect.objectContaining({ code: 'PASSWORD_TOO_SHORT' }));
    expect(() => assertPasswordPolicy('')).toThrow(ValidationError);
  });

  it('cuenta caracteres Unicode, no unidades UTF-16', () => {
    // 5 emojis = 10 unidades UTF-16 pero 5 caracteres.
    expect(() => assertPasswordPolicy('🔒🔒🔒🔒🔒')).toThrow(expect.objectContaining({ code: 'PASSWORD_TOO_SHORT' }));
    expect(() => assertPasswordPolicy('ñandú-pass')).not.toThrow();
  });

  it('rechaza más de 128 caracteres con PASSWORD_TOO_LONG', () => {
    expect(() => assertPasswordPolicy('a'.repeat(128))).not.toThrow();
    expect(() => assertPasswordPolicy('a'.repeat(129))).toThrow(expect.objectContaining({ code: 'PASSWORD_TOO_LONG' }));
  });
});

describe('bloqueo por intentos fallidos', () => {
  const now = new Date('2026-10-02T15:00:00Z');
  const clean: LoginState = { failedLogins: 0, lockedUntil: null };

  it('suma un fallo sin bloquear antes del quinto', () => {
    let state = clean;
    for (let i = 1; i < MAX_FAILED_LOGINS; i++) {
      state = afterFailedLogin(state, now);
      expect(state).toEqual({ failedLogins: i, lockedUntil: null });
      expect(isLocked(state, now)).toBe(false);
    }
  });

  it('al quinto fallo bloquea 15 minutos y reinicia el contador', () => {
    const state = afterFailedLogin({ failedLogins: MAX_FAILED_LOGINS - 1, lockedUntil: null }, now);
    expect(state.failedLogins).toBe(0);
    expect(state.lockedUntil).toEqual(new Date(now.getTime() + LOCKOUT_MS));
    expect(LOCKOUT_MS).toBe(15 * 60 * 1000);
    expect(isLocked(state, now)).toBe(true);
    expect(isLocked(state, new Date(now.getTime() + LOCKOUT_MS - 1))).toBe(true);
    expect(isLocked(state, new Date(now.getTime() + LOCKOUT_MS))).toBe(false);
  });

  it('un bloqueo vencido se limpia en el siguiente fallo', () => {
    const expired: LoginState = { failedLogins: 0, lockedUntil: new Date(now.getTime() - 1000) };
    expect(isLocked(expired, now)).toBe(false);
    expect(afterFailedLogin(expired, now)).toEqual({ failedLogins: 1, lockedUntil: null });
  });
});

describe('canLogIn', () => {
  it('solo cuentas activas con contraseña', () => {
    expect(canLogIn({ status: 'active', passwordHash: '$argon2id$...' })).toBe(true);
    expect(canLogIn({ status: 'active', passwordHash: null })).toBe(false);
    for (const status of ['pending', 'blocked', 'anonymized'] as const) {
      expect(canLogIn({ status, passwordHash: '$argon2id$...' })).toBe(false);
    }
  });
});

describe('normalizeEmail', () => {
  it('recorta espacios y pasa a minúsculas', () => {
    expect(normalizeEmail('  Ana.Perez@Example.COM ')).toBe('ana.perez@example.com');
  });
});
