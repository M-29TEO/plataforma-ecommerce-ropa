import { Injectable } from '@nestjs/common';
import { AuditLog, AuthUser, Database, NotFoundError, Queryable } from '../../../shared-kernel';
import { assertNotSelf, assertRoleFitsUser, resolveRole } from '../domain/role-assignment';
import { assertCanBlock, assertManageable, generateTemporaryPassword, planStatusChange, StatusChange } from '../domain/user-admin';
import { normalizeEmail } from '../domain/user-account';
import { PasswordHasher, RoleRepository, UserAdminDetail, UserAdminRepository, UserAdminView, UserListFilter } from './ports';
import { RoleService } from './role.service';
import { SessionService } from './session.service';

export interface UserAdminContext {
  actor: AuthUser;
  ip: string | null;
}

export interface NewStaffInput {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  roles: string[];
}

const SELF_CODE = 'CANNOT_MANAGE_OWN_ACCOUNT';
const SELF_MESSAGE = 'No puedes bloquear ni resetear la contraseña de tu propia cuenta';

/**
 * Gestión de usuarios del backoffice: listado y ficha, alta de personal con contraseña temporal,
 * bloqueo/desbloqueo y reseteo de contraseña. Cada cambio se audita en platform.audit_log en la
 * misma transacción; bloquear o resetear cierra todas las sesiones del usuario (refresh tokens).
 * La contraseña temporal solo viaja en la respuesta: nunca se audita ni se registra.
 */
@Injectable()
export class UserAdminService {
  constructor(
    private readonly db: Database,
    private readonly users: UserAdminRepository,
    private readonly roles: RoleRepository,
    private readonly roleService: RoleService,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly audit: AuditLog,
  ) {}

  list(tenantId: string, filter: UserListFilter): Promise<{ items: UserAdminView[]; total: number }> {
    return this.users.list(this.db, tenantId, filter);
  }

  get(tenantId: string, userId: string): Promise<UserAdminDetail> {
    return this.detailOrThrow(this.db, tenantId, userId);
  }

  /**
   * Alta de un usuario staff activo con sus roles (≥ 1, todos de staff). Si recibe admin, en su
   * primer login se le exige dar de alta el 2FA (lo decide MfaService).
   */
  async createStaff(ctx: UserAdminContext, input: NewStaffInput): Promise<{ user: UserAdminView; temporaryPassword: string }> {
    const tenantId = ctx.actor.tenantId;
    const roleCodes = [...new Set(input.roles)].map((code) => {
      const role = resolveRole(code);
      assertRoleFitsUser('staff', role);
      return role.code;
    });
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.hasher.hash(temporaryPassword); // argon2 fuera de la transacción

    const user = await this.db.withTransaction(async (tx) => {
      await this.roleService.ensureSystemRoles(tx, tenantId);
      const email = normalizeEmail(input.email);
      const id = await this.users.insertStaff(tx, {
        tenantId,
        email,
        passwordHash,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        phone: input.phone ?? null,
      });
      for (const code of roleCodes) await this.roles.assign(tx, tenantId, id, code, ctx.actor.id);
      const created = await this.detailOrThrow(tx, tenantId, id);
      await this.record(tx, ctx, 'iam.user.created', id, undefined, { email, type: 'staff', status: 'active', roles: created.roles });
      return created;
    });
    return { user: stripDetail(user), temporaryPassword };
  }

  block(ctx: UserAdminContext, userId: string): Promise<UserAdminView> {
    return this.changeStatus(ctx, userId, 'block');
  }

  unblock(ctx: UserAdminContext, userId: string): Promise<UserAdminView> {
    return this.changeStatus(ctx, userId, 'unblock');
  }

  /** Nueva contraseña temporal; cierra sus sesiones y limpia el bloqueo por intentos fallidos. */
  async resetPassword(ctx: UserAdminContext, userId: string): Promise<{ temporaryPassword: string }> {
    const tenantId = ctx.actor.tenantId;
    assertNotSelf(ctx.actor.id, userId, SELF_CODE, SELF_MESSAGE);
    assertManageable((await this.detailOrThrow(this.db, tenantId, userId)).status); // antes de pagar argon2
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.hasher.hash(temporaryPassword);

    await this.db.withTransaction(async (tx) => {
      const status = await this.users.lockStatus(tx, tenantId, userId);
      if (!status) throw userNotFound();
      assertManageable(status);
      await this.users.setPassword(tx, userId, passwordHash);
      const revokedSessions = await this.sessions.revokeAll(tx, userId);
      await this.record(tx, ctx, 'iam.user.password_reset', userId, undefined, { revokedSessions });
    });
    return { temporaryPassword };
  }

  private async changeStatus(ctx: UserAdminContext, userId: string, change: StatusChange): Promise<UserAdminView> {
    const tenantId = ctx.actor.tenantId;
    assertNotSelf(ctx.actor.id, userId, SELF_CODE, SELF_MESSAGE);

    return this.db.withTransaction(async (tx) => {
      // Mismo candado que los cambios de roles: la regla del último admin no se salta en carrera.
      await this.roles.lockTenantRoles(tx, tenantId);
      const status = await this.users.lockStatus(tx, tenantId, userId);
      if (!status) throw userNotFound();
      if (!planStatusChange(status, change)) return stripDetail(await this.detailOrThrow(tx, tenantId, userId)); // ya estaba así

      let revokedSessions: number | undefined;
      if (change === 'block') {
        const isAdmin = await this.roles.hasRole(tx, tenantId, userId, 'admin');
        assertCanBlock(isAdmin, isAdmin ? await this.roles.countActiveAdmins(tx, tenantId, userId) : 0);
        await this.users.setStatus(tx, userId, 'blocked');
        revokedSessions = await this.sessions.revokeAll(tx, userId);
      } else {
        await this.users.setStatus(tx, userId, 'active');
      }
      const next = change === 'block' ? 'blocked' : 'active';
      await this.record(tx, ctx, change === 'block' ? 'iam.user.blocked' : 'iam.user.unblocked', userId, { status }, {
        status: next,
        ...(revokedSessions === undefined ? {} : { revokedSessions }),
      });
      return stripDetail(await this.detailOrThrow(tx, tenantId, userId));
    });
  }

  private async detailOrThrow(q: Queryable, tenantId: string, userId: string): Promise<UserAdminDetail> {
    const user = await this.users.findDetail(q, tenantId, userId);
    if (!user) throw userNotFound();
    return user;
  }

  private record(tx: Queryable, ctx: UserAdminContext, action: string, userId: string, before: unknown, after: unknown): Promise<void> {
    return this.audit.record(tx, {
      tenantId: ctx.actor.tenantId,
      actorId: ctx.actor.id,
      actorType: ctx.actor.type,
      actorIp: ctx.ip,
      action,
      entityType: 'user',
      entityId: userId,
      before,
      after,
    });
  }
}

function userNotFound(): NotFoundError {
  return new NotFoundError('USER_NOT_FOUND', 'El usuario no existe en esta tienda');
}

/** La vista del listado (sin lockedUntil, que solo va en la ficha). */
function stripDetail(user: UserAdminDetail): UserAdminView {
  const { lockedUntil: _lockedUntil, ...view } = user;
  return view;
}
