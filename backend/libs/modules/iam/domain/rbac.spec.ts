import { assertNotLastAdmin, assertNotSelf, assertRoleFitsUser, resolveRole } from './role-assignment';
import { ALL_PERMISSIONS, SYSTEM_ROLE_CODES, SYSTEM_ROLES } from './system-roles';

describe('roles del sistema', () => {
  it('son los 7 del enunciado más Logística, cada uno una vez', () => {
    expect(SYSTEM_ROLES.map((r) => r.code).sort()).toEqual([...SYSTEM_ROLE_CODES].sort());
  });

  it('admin tiene todos los permisos; cliente y motorizado, ninguno de backoffice', () => {
    expect(new Set(resolveRole('admin').permissions)).toEqual(new Set(ALL_PERMISSIONS));
    expect(resolveRole('customer').permissions).toEqual([]);
    expect(resolveRole('rider').permissions).toEqual([]);
  });

  it('ningún rol repite permisos ni usa uno fuera del catálogo', () => {
    const catalog = new Set(ALL_PERMISSIONS);
    for (const role of SYSTEM_ROLES) {
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
      for (const p of role.permissions) expect(catalog.has(p)).toBe(true);
    }
  });

  it('solo admin gestiona roles y resetea 2FA', () => {
    for (const role of SYSTEM_ROLES.filter((r) => r.code !== 'admin')) {
      expect(role.permissions).not.toContain('iam.roles.assign');
      expect(role.permissions).not.toContain('iam.mfa.reset');
    }
  });

  it('separación de funciones: bodega no aprueba reembolsos; soporte no ajusta stock', () => {
    expect(resolveRole('warehouse').permissions).not.toContain('payments.refund.approve');
    expect(resolveRole('support').permissions).not.toContain('inventory.adjust');
    expect(resolveRole('seller').permissions).toContain('catalog.product.write');
    expect(resolveRole('logistics').permissions).toContain('payments.transfer.verify');
    expect(resolveRole('logistics').permissions).not.toContain('payments.refund.approve');
    expect(resolveRole('logistics').permissions).not.toContain('inventory.adjust');
  });
});

describe('reglas de asignación', () => {
  it('rol inexistente: ROLE_NOT_FOUND', () => {
    expect(() => resolveRole('superusuario')).toThrow(expect.objectContaining({ code: 'ROLE_NOT_FOUND', kind: 'not_found' }));
  });

  it('nadie cambia sus propios roles', () => {
    expect(() => assertNotSelf('u1', 'u1')).toThrow(expect.objectContaining({ code: 'CANNOT_CHANGE_OWN_ROLES', kind: 'forbidden' }));
    expect(() => assertNotSelf('u1', 'u2')).not.toThrow();
  });

  it('el rol debe corresponder al tipo de usuario', () => {
    expect(() => assertRoleFitsUser('customer', resolveRole('admin'))).toThrow(
      expect.objectContaining({ code: 'ROLE_NOT_ALLOWED_FOR_USER_TYPE' }),
    );
    expect(() => assertRoleFitsUser('staff', resolveRole('rider'))).toThrow();
    expect(() => assertRoleFitsUser('rider', resolveRole('rider'))).not.toThrow();
    expect(() => assertRoleFitsUser('staff', resolveRole('warehouse'))).not.toThrow();
  });

  it('no se quita el último admin activo (cuenta los OTROS admins activos)', () => {
    expect(() => assertNotLastAdmin('admin', 0)).toThrow(expect.objectContaining({ code: 'LAST_ADMIN', kind: 'conflict' }));
    expect(() => assertNotLastAdmin('admin', 1)).not.toThrow();
    expect(() => assertNotLastAdmin('seller', 0)).not.toThrow();
  });
});
