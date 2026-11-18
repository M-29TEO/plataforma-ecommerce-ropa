import { ConflictError, ForbiddenError, ValidationError } from '../../../shared-kernel';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password-policy';
import { assertNotSelf } from './role-assignment';
import {
  assertCanBlock,
  assertManageable,
  escapeLike,
  generateTemporaryPassword,
  planStatusChange,
  TEMPORARY_PASSWORD_ALPHABET,
  TEMPORARY_PASSWORD_LENGTH,
} from './user-admin';

describe('Gestión de usuarios (dominio)', () => {
  describe('contraseña temporal', () => {
    it('cumple la política: ≥ 16 caracteres y dentro de los límites, solo del alfabeto sin ambiguos', () => {
      const pwd = generateTemporaryPassword();
      expect(pwd).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
      expect(pwd.length).toBeGreaterThanOrEqual(16);
      expect(pwd.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
      expect(pwd.length).toBeLessThanOrEqual(PASSWORD_MAX_LENGTH);
      expect([...pwd].every((c) => TEMPORARY_PASSWORD_ALPHABET.includes(c))).toBe(true);
      expect(pwd).not.toMatch(/[0O1lI]/);
    });

    it('es aleatoria: 200 generaciones no se repiten', () => {
      expect(new Set(Array.from({ length: 200 }, () => generateTemporaryPassword())).size).toBe(200);
    });

    it('usa la fuente de aleatoriedad para cada carácter (con el rango del alfabeto completo)', () => {
      const maxes: number[] = [];
      const pwd = generateTemporaryPassword((max) => {
        maxes.push(max);
        return max - 1;
      });
      expect(maxes).toEqual(Array(TEMPORARY_PASSWORD_LENGTH).fill(TEMPORARY_PASSWORD_ALPHABET.length));
      expect(pwd).toBe('9'.repeat(TEMPORARY_PASSWORD_LENGTH));
    });
  });

  describe('bloqueo y desbloqueo', () => {
    it('bloquear cambia una cuenta activa; una ya bloqueada no cambia (idempotente)', () => {
      expect(planStatusChange('active', 'block')).toBe(true);
      expect(planStatusChange('blocked', 'block')).toBe(false);
    });

    it('desbloquear cambia una bloqueada; una activa no cambia', () => {
      expect(planStatusChange('blocked', 'unblock')).toBe(true);
      expect(planStatusChange('active', 'unblock')).toBe(false);
    });

    it('una cuenta anonimizada o pendiente no se gestiona (422 USER_STATUS_NOT_MANAGEABLE)', () => {
      for (const status of ['anonymized', 'pending'] as const) {
        expect(() => planStatusChange(status, 'block')).toThrow(ValidationError);
        expect(() => assertManageable(status)).toThrow(expect.objectContaining({ code: 'USER_STATUS_NOT_MANAGEABLE' }));
      }
      expect(() => assertManageable('active')).not.toThrow();
      expect(() => assertManageable('blocked')).not.toThrow();
    });

    it('no se bloquea al último admin activo (409 LAST_ADMIN); a otro rol o con más admins, sí', () => {
      expect(() => assertCanBlock(true, 0)).toThrow(ConflictError);
      expect(() => assertCanBlock(true, 0)).toThrow(expect.objectContaining({ code: 'LAST_ADMIN' }));
      expect(() => assertCanBlock(true, 1)).not.toThrow();
      expect(() => assertCanBlock(false, 0)).not.toThrow();
    });

    it('nadie se gestiona a sí mismo (403 con el código indicado)', () => {
      expect(() => assertNotSelf('a', 'a', 'CANNOT_MANAGE_OWN_ACCOUNT', 'x')).toThrow(ForbiddenError);
      expect(() => assertNotSelf('a', 'a', 'CANNOT_MANAGE_OWN_ACCOUNT', 'x')).toThrow(expect.objectContaining({ code: 'CANNOT_MANAGE_OWN_ACCOUNT' }));
      expect(() => assertNotSelf('a', 'a')).toThrow(expect.objectContaining({ code: 'CANNOT_CHANGE_OWN_ROLES' }));
      expect(() => assertNotSelf('a', 'b', 'CANNOT_MANAGE_OWN_ACCOUNT', 'x')).not.toThrow();
    });
  });

  it('escapeLike escapa %, _ y \\ para la búsqueda literal', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('ana@x.ec')).toBe('ana@x.ec');
  });
});
