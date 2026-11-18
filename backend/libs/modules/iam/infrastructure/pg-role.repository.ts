import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { RoleRepository, RoleTarget, RoleView, UserRoleView } from '../application/ports';
import { findSystemRole, SystemRole } from '../domain/system-roles';

@Injectable()
export class PgRoleRepository extends RoleRepository {
  async syncSystemRoles(q: Queryable, tenantId: string, roles: readonly SystemRole[]): Promise<void> {
    const codes = roles.map((r) => r.code);
    await q.query(
      `INSERT INTO iam.roles (tenant_id, code, name, is_system)
       SELECT $1, code, name, true FROM unnest($2::text[], $3::text[]) AS t(code, name)
       ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, is_system = true`,
      [tenantId, codes, roles.map((r) => r.name)],
    );
    // Pares (rol, permiso) deseados: lo que sobre se borra y lo que falte se inserta.
    const pairCodes = roles.flatMap((r) => r.permissions.map(() => r.code));
    const pairPerms = roles.flatMap((r) => [...r.permissions]);
    await q.query(
      `DELETE FROM iam.role_permissions rp
         USING iam.roles r
        WHERE rp.role_id = r.id AND r.tenant_id = $1 AND r.code = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM unnest($3::text[], $4::text[]) AS w(code, perm)
                           WHERE w.code = r.code AND w.perm = rp.permission_code)`,
      [tenantId, codes, pairCodes, pairPerms],
    );
    await q.query(
      `INSERT INTO iam.role_permissions (role_id, permission_code)
       SELECT r.id, w.perm FROM unnest($2::text[], $3::text[]) AS w(code, perm)
         JOIN iam.roles r ON r.tenant_id = $1 AND r.code = w.code
       ON CONFLICT DO NOTHING`,
      [tenantId, pairCodes, pairPerms],
    );
  }

  async listRoles(q: Queryable, tenantId: string): Promise<RoleView[]> {
    const { rows } = await q.query<{ code: string; name: string; is_system: boolean; permissions: string[] }>(
      `SELECT r.code, r.name, r.is_system,
              COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
         FROM iam.roles r
         LEFT JOIN iam.role_permissions rp ON rp.role_id = r.id
        WHERE r.tenant_id = $1
        GROUP BY r.id
        ORDER BY r.code`,
      [tenantId],
    );
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      isSystem: r.is_system,
      userType: (r.is_system && findSystemRole(r.code)?.userType) || 'staff',
      permissions: r.permissions,
    }));
  }

  async listUserRoles(q: Queryable, tenantId: string, userId: string): Promise<UserRoleView[]> {
    const { rows } = await q.query<{ code: string; name: string; granted_by: string | null; granted_at: Date }>(
      `SELECT r.code, r.name, ur.granted_by, ur.granted_at
         FROM iam.user_roles ur JOIN iam.roles r ON r.id = ur.role_id
        WHERE r.tenant_id = $1 AND ur.user_id = $2
        ORDER BY r.code`,
      [tenantId, userId],
    );
    return rows.map((r) => ({ code: r.code, name: r.name, grantedBy: r.granted_by, grantedAt: r.granted_at }));
  }

  async findTarget(q: Queryable, tenantId: string, userId: string): Promise<RoleTarget | null> {
    const { rows } = await q.query<{ id: string; user_type: RoleTarget['type'] }>(
      `SELECT id, user_type FROM iam.users WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, userId],
    );
    return rows[0] ? { id: rows[0].id, type: rows[0].user_type } : null;
  }

  async assign(q: Queryable, tenantId: string, userId: string, roleCode: string, grantedBy: string | null): Promise<boolean> {
    const { rowCount } = await q.query(
      `INSERT INTO iam.user_roles (user_id, role_id, granted_by)
       SELECT $2, id, $4 FROM iam.roles WHERE tenant_id = $1 AND code = $3
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [tenantId, userId, roleCode, grantedBy],
    );
    return (rowCount ?? 0) > 0;
  }

  async remove(q: Queryable, tenantId: string, userId: string, roleCode: string): Promise<boolean> {
    const { rowCount } = await q.query(
      `DELETE FROM iam.user_roles ur USING iam.roles r
        WHERE ur.role_id = r.id AND r.tenant_id = $1 AND ur.user_id = $2 AND r.code = $3`,
      [tenantId, userId, roleCode],
    );
    return (rowCount ?? 0) > 0;
  }

  async countActiveAdmins(q: Queryable, tenantId: string, exceptUserId: string): Promise<number> {
    const { rows } = await q.query<{ n: number }>(
      `SELECT count(DISTINCT u.id)::int AS n
         FROM iam.user_roles ur
         JOIN iam.roles r ON r.id = ur.role_id AND r.code = 'admin'
         JOIN iam.users u ON u.id = ur.user_id AND u.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL AND u.id <> $2`,
      [tenantId, exceptUserId],
    );
    return rows[0].n;
  }

  async permissionsOf(q: Queryable, tenantId: string, userId: string): Promise<string[]> {
    const { rows } = await q.query<{ code: string }>(
      `SELECT DISTINCT rp.permission_code AS code
         FROM iam.user_roles ur
         JOIN iam.roles r ON r.id = ur.role_id AND r.tenant_id = $1
         JOIN iam.role_permissions rp ON rp.role_id = r.id
        WHERE ur.user_id = $2
        ORDER BY 1`,
      [tenantId, userId],
    );
    return rows.map((r) => r.code);
  }

  async hasRole(q: Queryable, tenantId: string, userId: string, roleCode: string): Promise<boolean> {
    const { rows } = await q.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM iam.user_roles ur JOIN iam.roles r ON r.id = ur.role_id
                       WHERE r.tenant_id = $1 AND ur.user_id = $2 AND r.code = $3) AS ok`,
      [tenantId, userId, roleCode],
    );
    return rows[0].ok;
  }

  async lockTenantRoles(q: Queryable, tenantId: string): Promise<void> {
    await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('iam.roles:' || $1, 0))`, [tenantId]);
  }
}
