import { Injectable } from '@nestjs/common';
import { ConflictError, isUniqueViolation, Queryable } from '../../../shared-kernel';
import { NewStaffUser, UserAdminDetail, UserAdminRepository, UserAdminView, UserListFilter } from '../application/ports';
import { escapeLike } from '../domain/user-admin';
import { UserStatus } from '../domain/user-account';

interface Row {
  id: string;
  user_type: UserAdminView['type'];
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  status: UserStatus;
  mfa_enabled: boolean;
  roles: string[];
  last_login_at: Date | null;
  created_at: Date;
  locked_until: Date | null;
}

/** Columnas de la vista; los roles se agregan con una subconsulta del mismo schema (iam). */
const COLUMNS = `u.id, u.user_type, u.email::text AS email, u.first_name, u.last_name, u.phone, u.status, u.mfa_enabled,
       u.last_login_at, u.created_at, u.locked_until,
       ARRAY(SELECT r.code FROM iam.user_roles ur JOIN iam.roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id AND r.tenant_id = u.tenant_id ORDER BY r.code) AS roles`;

function toView(r: Row): UserAdminView {
  return {
    id: r.id,
    type: r.user_type,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    phone: r.phone,
    status: r.status,
    mfaEnabled: r.mfa_enabled,
    roles: r.roles,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  };
}

@Injectable()
export class PgUserAdminRepository extends UserAdminRepository {
  async list(q: Queryable, tenantId: string, f: UserListFilter): Promise<{ items: UserAdminView[]; total: number }> {
    const params: unknown[] = [tenantId];
    const add = (v: unknown) => `$${params.push(v)}`;
    const where = ['u.tenant_id = $1', 'u.deleted_at IS NULL'];
    where.push(f.status ? `u.status = ${add(f.status)}` : `u.status <> 'anonymized'`);
    if (f.type) where.push(`u.user_type = ${add(f.type)}`);
    if (f.role) {
      where.push(`EXISTS (SELECT 1 FROM iam.user_roles ur JOIN iam.roles r ON r.id = ur.role_id
                           WHERE ur.user_id = u.id AND r.tenant_id = u.tenant_id AND r.code = ${add(f.role)})`);
    }
    if (f.q) {
      const like = add(`%${escapeLike(f.q)}%`);
      where.push(`(u.email::text ILIKE ${like} OR u.first_name ILIKE ${like} OR u.last_name ILIKE ${like} OR u.phone ILIKE ${like})`);
    }
    const filter = where.join(' AND ');
    const total = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM iam.users u WHERE ${filter}`, params);
    const { rows } = await q.query<Row>(
      `SELECT ${COLUMNS} FROM iam.users u WHERE ${filter}
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT ${add(f.limit)} OFFSET ${add(f.offset)}`,
      params,
    );
    return { items: rows.map(toView), total: total.rows[0].n };
  }

  async findDetail(q: Queryable, tenantId: string, userId: string): Promise<UserAdminDetail | null> {
    const { rows } = await q.query<Row>(`SELECT ${COLUMNS} FROM iam.users u WHERE u.tenant_id = $1 AND u.id = $2 AND u.deleted_at IS NULL`, [
      tenantId,
      userId,
    ]);
    return rows[0] ? { ...toView(rows[0]), lockedUntil: rows[0].locked_until } : null;
  }

  async lockStatus(q: Queryable, tenantId: string, userId: string): Promise<UserStatus | null> {
    const { rows } = await q.query<{ status: UserStatus }>(
      `SELECT status FROM iam.users WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [tenantId, userId],
    );
    return rows[0]?.status ?? null;
  }

  async insertStaff(q: Queryable, u: NewStaffUser): Promise<string> {
    try {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO iam.users (tenant_id, user_type, email, password_hash, first_name, last_name, phone, status)
         VALUES ($1, 'staff', $2, $3, $4, $5, $6, 'active')
         RETURNING id`,
        [u.tenantId, u.email, u.passwordHash, u.firstName, u.lastName, u.phone],
      );
      return rows[0].id;
    } catch (error) {
      // UNIQUE (tenant_id, email) sobre citext: también choca con otra capitalización o con una cuenta borrada.
      if (isUniqueViolation(error, 'users_tenant_id_email_key')) {
        throw new ConflictError('EMAIL_TAKEN', 'Ya existe una cuenta con ese email');
      }
      throw error;
    }
  }

  async setStatus(q: Queryable, userId: string, status: 'active' | 'blocked'): Promise<void> {
    await q.query(`UPDATE iam.users SET status = $2, updated_at = now() WHERE id = $1`, [userId, status]);
  }

  async setPassword(q: Queryable, userId: string, passwordHash: string): Promise<void> {
    await q.query(
      `UPDATE iam.users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
      [userId, passwordHash],
    );
  }
}
