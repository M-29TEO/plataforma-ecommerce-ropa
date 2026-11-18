/** Puertos del módulo IAM (schema iam: tenants, users, consents). */
import { Queryable } from '../../../shared-kernel';
import { ConsentPurpose, ConsentRecord } from '../domain/consent';
import { StoredRefreshToken } from '../domain/refresh-token';
import { SystemRole } from '../domain/system-roles';
import { LoginAccount, LoginState, UserStatus, UserType } from '../domain/user-account';

export interface UserContact {
  userId: string;
  tenantId: string;
  userType: 'customer' | 'staff' | 'rider';
  email: string;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  locale: string;
  status: 'pending' | 'active' | 'blocked' | 'anonymized';
}

/**
 * Cliente encontrado por la búsqueda del backoffice (pedidos asistidos). Solo datos de contacto y
 * de facturación: nunca hash de contraseña, secreto 2FA ni datos de sesión.
 */
export interface CustomerSummary {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  idType: string | null;
  idNumber: string | null;
  status: 'pending' | 'active' | 'blocked';
}

export abstract class UserDirectory {
  abstract findContact(q: Queryable, tenantId: string, userId: string): Promise<UserContact | null>;
  /**
   * Clientes (user_type 'customer', no borrados ni anonimizados) cuyo email, nombre, apellido,
   * teléfono o número de identificación contiene `term`. Máximo `limit`.
   */
  abstract searchCustomers(q: Queryable, tenantId: string, term: string, limit: number): Promise<CustomerSummary[]>;
  /** Un cliente por id con sus datos de facturación (null si no es cliente, está borrado o anonimizado). */
  abstract findCustomer(q: Queryable, tenantId: string, userId: string): Promise<CustomerSummary | null>;
  abstract findIdByEmail(q: Queryable, tenantId: string, email: string): Promise<string | null>;
  /** true si es staff activo (no borrado) y alguno de sus roles del tenant otorga el permiso. */
  abstract staffHasPermission(q: Queryable, tenantId: string, userId: string, permission: string): Promise<boolean>;
}

export interface NewConsent {
  userId: string | null;
  guestEmail: string | null;
  purpose: ConsentPurpose;
  policyVersion: string;
  granted: boolean;
  ip: string | null;
}

export abstract class ConsentRepository {
  abstract insert(q: Queryable, c: NewConsent): Promise<void>;
  abstract listByUser(q: Queryable, userId: string): Promise<ConsentRecord[]>;
  /** Filas de un invitado (user_id NULL). */
  abstract listByGuestEmail(q: Queryable, email: string): Promise<ConsentRecord[]>;
}

export interface NewCustomer {
  tenantId: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  phone: string;
}

/** Perfil propio (GET /me). Nunca incluye el hash de la contraseña. */
export interface UserProfile {
  id: string;
  tenantId: string;
  type: UserType;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  locale: string;
  status: UserStatus;
  emailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: Date;
}

export abstract class UserAccountRepository {
  /** null si el tenant no existe. */
  abstract findTenantStatus(q: Queryable, tenantId: string): Promise<'active' | 'suspended' | null>;
  /** Lanza ConflictError EMAIL_TAKEN si el email ya existe en el tenant. */
  abstract insertCustomer(q: Queryable, c: NewCustomer): Promise<UserProfile>;
  /** Cuenta no borrada con ese email en el tenant. */
  abstract findForLogin(q: Queryable, tenantId: string, email: string): Promise<LoginAccount | null>;
  /** Lee failed_logins y locked_until con SELECT ... FOR UPDATE (usar dentro de una transacción). */
  abstract lockLoginState(q: Queryable, userId: string): Promise<LoginState>;
  abstract saveLoginState(q: Queryable, userId: string, state: LoginState, lastLoginAt?: Date): Promise<void>;
  abstract findProfile(q: Queryable, tenantId: string, userId: string): Promise<UserProfile | null>;
  /** Estado del 2FA de un usuario no borrado del tenant. */
  abstract findMfaState(q: Queryable, tenantId: string, userId: string): Promise<MfaState | null>;
  /** Guarda el secreto TOTP cifrado (null lo borra) y si el 2FA está activo. */
  abstract saveMfa(q: Queryable, userId: string, secretEnc: Buffer | null, enabled: boolean): Promise<void>;
  /** Datos para renovar una sesión; incluye las cuentas borradas (deleted = true) para cortarlas. */
  abstract findSessionUser(q: Queryable, userId: string): Promise<SessionUser | null>;
}

export interface MfaState {
  id: string;
  tenantId: string;
  type: UserType;
  email: string;
  status: UserStatus;
  mfaEnabled: boolean;
  /** nonce || crypto_secretbox(secreto); con mfaEnabled = false es un alta pendiente de activar. */
  secretEnc: Buffer | null;
}

/** Cifrado simétrico autenticado de secretos en reposo (libsodium crypto_secretbox en infraestructura). */
export abstract class SecretBox {
  abstract seal(plain: Buffer): Promise<Buffer>;
  /** Lanza si el texto cifrado fue alterado o es de otra clave. */
  abstract open(sealed: Buffer): Promise<Buffer>;
}

/** Anti-replay de códigos TOTP: cada (usuario, paso de 30 s) se acepta una sola vez. */
export abstract class TotpReplayGuard {
  /** true si es la primera vez que se usa ese paso para ese usuario. */
  abstract claim(userId: string, step: number): Promise<boolean>;
}

export interface SessionUser {
  id: string;
  tenantId: string;
  type: UserType;
  status: UserStatus;
  deleted: boolean;
}

export interface NewRefreshToken {
  userId: string;
  familyId: string;
  tokenHash: Buffer;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
}

export abstract class RefreshTokenRepository {
  abstract insert(q: Queryable, t: NewRefreshToken): Promise<void>;
  /** Busca por hash con SELECT ... FOR UPDATE: dos refresh simultáneos del mismo token se serializan. */
  abstract findByHashForUpdate(q: Queryable, tokenHash: Buffer): Promise<StoredRefreshToken | null>;
  abstract revoke(q: Queryable, id: string, now: Date): Promise<void>;
  /** Revoca los tokens vigentes de la familia; devuelve cuántos. */
  abstract revokeFamily(q: Queryable, familyId: string, now: Date): Promise<number>;
  /** Revoca todas las sesiones del usuario; devuelve cuántos tokens. */
  abstract revokeAllForUser(q: Queryable, userId: string, now: Date): Promise<number>;
}

export interface RoleView {
  code: string;
  name: string;
  isSystem: boolean;
  /** Tipo de usuario al que se puede asignar (los roles propios del tenant son de staff). */
  userType: UserType;
  permissions: string[];
}

export interface UserRoleView {
  code: string;
  name: string;
  grantedBy: string | null;
  grantedAt: Date;
}

export interface RoleTarget {
  id: string;
  type: UserType;
}

export abstract class RoleRepository {
  /** Crea o actualiza los roles del sistema del tenant y deja sus permisos exactamente como en `roles`. */
  abstract syncSystemRoles(q: Queryable, tenantId: string, roles: readonly SystemRole[]): Promise<void>;
  abstract listRoles(q: Queryable, tenantId: string): Promise<RoleView[]>;
  abstract listUserRoles(q: Queryable, tenantId: string, userId: string): Promise<UserRoleView[]>;
  /** Usuario no borrado del tenant (destino de una asignación). */
  abstract findTarget(q: Queryable, tenantId: string, userId: string): Promise<RoleTarget | null>;
  /** false si ya lo tenía. */
  abstract assign(q: Queryable, tenantId: string, userId: string, roleCode: string, grantedBy: string | null): Promise<boolean>;
  /** false si no lo tenía. */
  abstract remove(q: Queryable, tenantId: string, userId: string, roleCode: string): Promise<boolean>;
  /** Usuarios activos y no borrados con el rol admin en el tenant, sin contar a exceptUserId. */
  abstract countActiveAdmins(q: Queryable, tenantId: string, exceptUserId: string): Promise<number>;
  /** Unión de los permisos de los roles del usuario (van en el JWT). */
  abstract permissionsOf(q: Queryable, tenantId: string, userId: string): Promise<string[]>;
  abstract hasRole(q: Queryable, tenantId: string, userId: string, roleCode: string): Promise<boolean>;
  /** Serializa los cambios de roles del tenant (pg_advisory_xact_lock): la regla del último admin no se salta en carrera. */
  abstract lockTenantRoles(q: Queryable, tenantId: string): Promise<void>;
}

/** Fila del listado de usuarios del backoffice (nunca incluye hash, secreto 2FA ni datos de identificación). */
export interface UserAdminView {
  id: string;
  type: UserType;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  status: UserStatus;
  mfaEnabled: boolean;
  /** Códigos de rol, ordenados. */
  roles: string[];
  lastLoginAt: Date | null;
  createdAt: Date;
}

/** Detalle: además, hasta cuándo está bloqueada por intentos fallidos (null si no lo está). */
export interface UserAdminDetail extends UserAdminView {
  lockedUntil: Date | null;
}

export interface UserListFilter {
  /** Texto libre: email, nombre, apellido o teléfono (ILIKE, comodines escapados). */
  q?: string;
  type?: UserType;
  /** Sin estado se excluyen las cuentas anonimizadas. */
  status?: 'active' | 'blocked' | 'pending';
  role?: string;
  limit: number;
  offset: number;
}

export interface NewStaffUser {
  tenantId: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  phone: string | null;
}

/** Gestión de cuentas desde el backoffice (iam.users + sus roles). Las cuentas borradas no existen aquí. */
export abstract class UserAdminRepository {
  abstract list(q: Queryable, tenantId: string, filter: UserListFilter): Promise<{ items: UserAdminView[]; total: number }>;
  abstract findDetail(q: Queryable, tenantId: string, userId: string): Promise<UserAdminDetail | null>;
  /** Estado con SELECT ... FOR UPDATE (usar dentro de una transacción). */
  abstract lockStatus(q: Queryable, tenantId: string, userId: string): Promise<UserStatus | null>;
  /** Usuario staff activo. Lanza ConflictError EMAIL_TAKEN si el email ya existe en el tenant. */
  abstract insertStaff(q: Queryable, u: NewStaffUser): Promise<string>;
  abstract setStatus(q: Queryable, userId: string, status: 'active' | 'blocked'): Promise<void>;
  /** Nueva contraseña y limpia el bloqueo por intentos fallidos. */
  abstract setPassword(q: Queryable, userId: string, passwordHash: string): Promise<void>;
}

/** Hash de contraseñas (argon2id en infraestructura). */
export abstract class PasswordHasher {
  abstract hash(password: string): Promise<string>;
  /** false si no coincide o el hash es inválido; nunca lanza por una contraseña errónea. */
  abstract verify(hash: string, password: string): Promise<boolean>;
}
