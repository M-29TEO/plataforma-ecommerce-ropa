import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../shared-kernel';
import { canHoldRole, findSystemRole, SystemRole } from './system-roles';
import { UserType } from './user-account';

/** Reglas para asignar o quitar un rol (las verifica RoleService dentro de la transacción). */

/**
 * Nadie cambia sus propios roles: ni se autoescala ni se deja a sí mismo sin acceso. La misma
 * regla vale para bloquear o resetear la contraseña de la propia cuenta (con otro código).
 */
export function assertNotSelf(
  actorId: string,
  targetUserId: string,
  code = 'CANNOT_CHANGE_OWN_ROLES',
  message = 'No puedes cambiar tus propios roles',
): void {
  if (actorId === targetUserId) throw new ForbiddenError(code, message);
}

export function resolveRole(code: string): SystemRole {
  const role = findSystemRole(code);
  if (!role) throw new NotFoundError('ROLE_NOT_FOUND', `No existe el rol ${code}`, { code });
  return role;
}

export function assertRoleFitsUser(userType: UserType, role: SystemRole): void {
  if (!canHoldRole(userType, role)) {
    throw new ValidationError('ROLE_NOT_ALLOWED_FOR_USER_TYPE', `El rol ${role.code} es para usuarios de tipo ${role.userType}`, {
      role: role.code,
      requiredUserType: role.userType,
      userType,
    });
  }
}

/**
 * El tenant nunca se queda sin un administrador activo. otherActiveAdmins = admins activos sin
 * contar al usuario al que se le quita el rol (si él estaba bloqueado, no cuenta de todos modos).
 * Normalmente quien quita es otro admin, pero su JWT puede tener permisos de un rol que ya perdió.
 */
export function assertNotLastAdmin(roleCode: string, otherActiveAdmins: number): void {
  if (roleCode === 'admin' && otherActiveAdmins < 1) {
    throw new ConflictError('LAST_ADMIN', 'No se puede quitar el rol admin al último administrador activo');
  }
}
