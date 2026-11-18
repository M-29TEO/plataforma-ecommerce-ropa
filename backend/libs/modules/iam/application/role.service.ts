import { Injectable } from '@nestjs/common';
import { AuditLog, AuthUser, Database, NotFoundError, Queryable } from '../../../shared-kernel';
import { assertNotLastAdmin, assertNotSelf, assertRoleFitsUser, resolveRole } from '../domain/role-assignment';
import { SYSTEM_ROLES } from '../domain/system-roles';
import { RoleRepository, RoleView, UserRoleView } from './ports';

export interface RoleChangeContext {
  actor: AuthUser;
  ip: string | null;
}

/**
 * RBAC: roles del sistema por tenant (sincronizados desde domain/system-roles.ts) y su
 * asignación por un admin. Cada cambio queda en platform.audit_log en la misma transacción.
 * Los permisos viajan en el JWT: un cambio rige desde el siguiente login o refresh (≤ 15 min).
 */
@Injectable()
export class RoleService {
  /** Tenants ya sincronizados en este proceso (la sincronización es idempotente, esto solo ahorra consultas). */
  private readonly provisioned = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly roles: RoleRepository,
    private readonly audit: AuditLog,
  ) {}

  /** Crea o actualiza los 7 roles del sistema y sus permisos en el tenant. */
  async ensureSystemRoles(q: Queryable, tenantId: string): Promise<void> {
    if (this.provisioned.has(tenantId)) return;
    await this.roles.syncSystemRoles(q, tenantId, SYSTEM_ROLES);
    // Dentro de una transacción, se marca cuando ya no pueda hacer rollback por esta causa: si la
    // transacción de afuera falla, la próxima llamada vuelve a sincronizar (es idempotente).
    if (!this.db.inTransaction()) this.provisioned.add(tenantId);
  }

  /** Rol inicial de un usuario recién creado (p. ej. customer al registrarse), sin auditoría de admin. */
  async grantInitialRole(q: Queryable, tenantId: string, userId: string, roleCode: string): Promise<void> {
    await this.ensureSystemRoles(q, tenantId);
    await this.roles.assign(q, tenantId, userId, roleCode, null);
  }

  permissionsOf(q: Queryable, tenantId: string, userId: string): Promise<string[]> {
    return this.roles.permissionsOf(q, tenantId, userId);
  }

  hasRole(q: Queryable, tenantId: string, userId: string, roleCode: string): Promise<boolean> {
    return this.roles.hasRole(q, tenantId, userId, roleCode);
  }

  async listRoles(tenantId: string): Promise<RoleView[]> {
    await this.ensureSystemRoles(this.db, tenantId);
    return this.roles.listRoles(this.db, tenantId);
  }

  async listUserRoles(tenantId: string, userId: string): Promise<UserRoleView[]> {
    await this.findTargetOrThrow(this.db, tenantId, userId);
    return this.roles.listUserRoles(this.db, tenantId, userId);
  }

  /** Idempotente: si ya lo tenía, devuelve sus roles sin auditar nada. */
  assign(ctx: RoleChangeContext, userId: string, roleCode: string): Promise<UserRoleView[]> {
    return this.change(ctx, userId, roleCode, 'assign');
  }

  remove(ctx: RoleChangeContext, userId: string, roleCode: string): Promise<UserRoleView[]> {
    return this.change(ctx, userId, roleCode, 'remove');
  }

  private async change(ctx: RoleChangeContext, userId: string, roleCode: string, op: 'assign' | 'remove'): Promise<UserRoleView[]> {
    const tenantId = ctx.actor.tenantId;
    assertNotSelf(ctx.actor.id, userId);
    const role = resolveRole(roleCode);

    return this.db.withTransaction(async (tx) => {
      await this.ensureSystemRoles(tx, tenantId);
      await this.roles.lockTenantRoles(tx, tenantId);
      const target = await this.findTargetOrThrow(tx, tenantId, userId);
      const before = await this.roles.listUserRoles(tx, tenantId, userId);

      let changed: boolean;
      if (op === 'assign') {
        assertRoleFitsUser(target.type, role);
        changed = await this.roles.assign(tx, tenantId, userId, role.code, ctx.actor.id);
      } else {
        if (!before.some((r) => r.code === role.code)) {
          throw new NotFoundError('ROLE_NOT_ASSIGNED', `El usuario no tiene el rol ${role.code}`, { role: role.code });
        }
        assertNotLastAdmin(role.code, await this.roles.countActiveAdmins(tx, tenantId, userId));
        changed = await this.roles.remove(tx, tenantId, userId, role.code);
      }

      const after = changed ? await this.roles.listUserRoles(tx, tenantId, userId) : before;
      if (changed) {
        await this.audit.record(tx, {
          tenantId,
          actorId: ctx.actor.id,
          actorType: ctx.actor.type,
          actorIp: ctx.ip,
          action: op === 'assign' ? 'iam.role.assigned' : 'iam.role.removed',
          entityType: 'user',
          entityId: userId,
          before: { roles: before.map((r) => r.code) },
          after: { roles: after.map((r) => r.code), role: role.code },
        });
      }
      return after;
    });
  }

  private async findTargetOrThrow(q: Queryable, tenantId: string, userId: string) {
    const target = await this.roles.findTarget(q, tenantId, userId);
    if (!target) throw new NotFoundError('USER_NOT_FOUND', 'El usuario no existe en esta tienda');
    return target;
  }
}
