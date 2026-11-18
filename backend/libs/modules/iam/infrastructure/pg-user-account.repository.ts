import { Injectable } from '@nestjs/common';
import { ConflictError, isUniqueViolation, Queryable } from '../../../shared-kernel';
import { MfaState, NewCustomer, SessionUser, UserAccountRepository, UserProfile } from '../application/ports';
import { LoginAccount, LoginState } from '../domain/user-account';

interface ProfileRow {
  id: string;
  tenant_id: string;
  user_type: UserProfile['type'];
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  locale: string;
  status: UserProfile['status'];
  email_verified_at: Date | null;
  mfa_enabled: boolean;
  created_at: Date;
}

interface LoginRow {
  id: string;
  tenant_id: string;
  user_type: LoginAccount['type'];
  status: LoginAccount['status'];
  password_hash: string | null;
  mfa_enabled: boolean;
  failed_logins: number;
  locked_until: Date | null;
}

const PROFILE_COLUMNS = `id, tenant_id, user_type, email::text AS email, first_name, last_name, phone, locale, status,
       email_verified_at, mfa_enabled, created_at`;

function toProfile(r: ProfileRow): UserProfile {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    type: r.user_type,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    phone: r.phone,
    locale: r.locale,
    status: r.status,
    emailVerified: r.email_verified_at !== null,
    mfaEnabled: r.mfa_enabled,
    createdAt: r.created_at,
  };
}

@Injectable()
export class PgUserAccountRepository extends UserAccountRepository {
  async findTenantStatus(q: Queryable, tenantId: string): Promise<'active' | 'suspended' | null> {
    const { rows } = await q.query<{ status: 'active' | 'suspended' }>(`SELECT status FROM iam.tenants WHERE id = $1`, [tenantId]);
    return rows[0]?.status ?? null;
  }

  async insertCustomer(q: Queryable, c: NewCustomer): Promise<UserProfile> {
    try {
      const { rows } = await q.query<ProfileRow>(
        `INSERT INTO iam.users (tenant_id, user_type, email, password_hash, first_name, last_name, phone)
         VALUES ($1, 'customer', $2, $3, $4, $5, $6)
         RETURNING ${PROFILE_COLUMNS}`,
        [c.tenantId, c.email, c.passwordHash, c.firstName, c.lastName, c.phone],
      );
      return toProfile(rows[0]);
    } catch (error) {
      // UNIQUE (tenant_id, email) sobre citext: también choca con otra capitalización.
      if (isUniqueViolation(error, 'users_tenant_id_email_key')) {
        throw new ConflictError('EMAIL_TAKEN', 'Ya existe una cuenta con ese email');
      }
      throw error;
    }
  }

  async findForLogin(q: Queryable, tenantId: string, email: string): Promise<LoginAccount | null> {
    const { rows } = await q.query<LoginRow>(
      `SELECT id, tenant_id, user_type, status, password_hash, mfa_enabled, failed_logins, locked_until
         FROM iam.users
        WHERE tenant_id = $1 AND email = $2 AND deleted_at IS NULL`,
      [tenantId, email],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      type: r.user_type,
      status: r.status,
      passwordHash: r.password_hash,
      mfaEnabled: r.mfa_enabled,
      failedLogins: r.failed_logins,
      lockedUntil: r.locked_until,
    };
  }

  async lockLoginState(q: Queryable, userId: string): Promise<LoginState> {
    const { rows } = await q.query<{ failed_logins: number; locked_until: Date | null }>(
      `SELECT failed_logins, locked_until FROM iam.users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    return { failedLogins: rows[0].failed_logins, lockedUntil: rows[0].locked_until };
  }

  async saveLoginState(q: Queryable, userId: string, state: LoginState, lastLoginAt?: Date): Promise<void> {
    await q.query(
      `UPDATE iam.users
          SET failed_logins = $2, locked_until = $3, last_login_at = COALESCE($4, last_login_at)
        WHERE id = $1`,
      [userId, state.failedLogins, state.lockedUntil, lastLoginAt ?? null],
    );
  }

  async findProfile(q: Queryable, tenantId: string, userId: string): Promise<UserProfile | null> {
    const { rows } = await q.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM iam.users WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, userId],
    );
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async findSessionUser(q: Queryable, userId: string): Promise<SessionUser | null> {
    const { rows } = await q.query<{ id: string; tenant_id: string; user_type: SessionUser['type']; status: SessionUser['status']; deleted: boolean }>(
      `SELECT id, tenant_id, user_type, status, deleted_at IS NOT NULL AS deleted FROM iam.users WHERE id = $1`,
      [userId],
    );
    const r = rows[0];
    return r ? { id: r.id, tenantId: r.tenant_id, type: r.user_type, status: r.status, deleted: r.deleted } : null;
  }

  async findMfaState(q: Queryable, tenantId: string, userId: string): Promise<MfaState | null> {
    const { rows } = await q.query<{
      id: string;
      tenant_id: string;
      user_type: MfaState['type'];
      email: string;
      status: MfaState['status'];
      mfa_enabled: boolean;
      mfa_secret_enc: Buffer | null;
    }>(
      `SELECT id, tenant_id, user_type, email::text AS email, status, mfa_enabled, mfa_secret_enc
         FROM iam.users WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, userId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      type: r.user_type,
      email: r.email,
      status: r.status,
      mfaEnabled: r.mfa_enabled,
      secretEnc: r.mfa_secret_enc,
    };
  }

  async saveMfa(q: Queryable, userId: string, secretEnc: Buffer | null, enabled: boolean): Promise<void> {
    await q.query(`UPDATE iam.users SET mfa_secret_enc = $2, mfa_enabled = $3, updated_at = now() WHERE id = $1`, [userId, secretEnc, enabled]);
  }
}
