import { Injectable, OnModuleInit } from '@nestjs/common';
import { AnonymizationResult, Database, DataSubject, PersonalDataContributor, PersonalDataRegistry } from '../../../shared-kernel';

/**
 * Derechos LOPDP del titular en el schema iam.
 *
 * Exporta: perfil de iam.users, códigos de rol, historial de consentimientos (con IP) y sesiones
 * (iam.refresh_tokens: fechas, user agent, IP; nunca token_hash ni family_id).
 * Anonimiza: email seudónimo (anonimizado+<id>@anonimizado.invalid, mantiene el UNIQUE por tenant),
 * borra teléfono, nombres, identificación, hash de contraseña y secreto 2FA; status 'anonymized' y
 * deleted_at (los repositorios excluyen la cuenta: login, /me y contactos fallan como "no existe").
 * Borra refresh tokens, identidades externas y roles. A los consentimientos les quita IP y email.
 * Conserva: el historial de consentimientos sin IP, como prueba de lo que el titular autorizó.
 * Va al final (order 100): los demás módulos usan el email del titular mientras anonimizan.
 */
@Injectable()
export class IamPersonalDataContributor extends PersonalDataContributor implements OnModuleInit {
  override readonly section = 'cuenta';
  override readonly order = 100;

  constructor(
    private readonly registry: PersonalDataRegistry,
    private readonly db: Database,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  override async resolve(s: DataSubject): Promise<Partial<Pick<DataSubject, 'email' | 'orderIds'>>> {
    const { rows } = await this.db.query<{ email: string }>(`SELECT email::text AS email FROM iam.users WHERE tenant_id = $1 AND id = $2`, [
      s.tenantId,
      s.userId,
    ]);
    return rows[0] ? { email: rows[0].email } : {};
  }

  override async exportData(s: DataSubject): Promise<unknown> {
    const { rows: users } = await this.db.query<{
      email: string;
      phone: string | null;
      first_name: string | null;
      last_name: string | null;
      id_type: string | null;
      id_number: string | null;
      locale: string;
      status: string;
      mfa_enabled: boolean;
      email_verified_at: Date | null;
      last_login_at: Date | null;
      created_at: Date;
    }>(
      `SELECT email::text AS email, phone, first_name, last_name, id_type, id_number, locale, status, mfa_enabled,
              email_verified_at, last_login_at, created_at
         FROM iam.users WHERE tenant_id = $1 AND id = $2`,
      [s.tenantId, s.userId],
    );
    const u = users[0];
    if (!u) return null;

    // Las tablas hijas no tienen tenant_id: el tenant se asegura con la fila padre de iam.users.
    const { rows: roles } = await this.db.query<{ code: string }>(
      `SELECT r.code
         FROM iam.user_roles ur
         JOIN iam.roles r ON r.id = ur.role_id AND r.tenant_id = $1
         JOIN iam.users u ON u.id = ur.user_id AND u.tenant_id = $1
        WHERE ur.user_id = $2
        ORDER BY r.code`,
      [s.tenantId, s.userId],
    );
    const { rows: consents } = await this.db.query<{ purpose: string; granted: boolean; policy_version: string; ip: string | null; created_at: Date }>(
      `SELECT c.purpose, c.granted, c.policy_version, host(c.ip) AS ip, c.created_at
         FROM iam.consents c
         JOIN iam.users u ON u.id = c.user_id AND u.tenant_id = $1
        WHERE c.user_id = $2
        ORDER BY c.created_at, c.id`,
      [s.tenantId, s.userId],
    );
    const { rows: sessions } = await this.db.query<{
      created_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
      user_agent: string | null;
      ip: string | null;
    }>(
      `SELECT t.created_at, t.expires_at, t.revoked_at, t.user_agent, host(t.ip) AS ip
         FROM iam.refresh_tokens t
         JOIN iam.users u ON u.id = t.user_id AND u.tenant_id = $1
        WHERE t.user_id = $2
        ORDER BY t.created_at`,
      [s.tenantId, s.userId],
    );

    return {
      profile: {
        email: u.email,
        phone: u.phone,
        firstName: u.first_name,
        lastName: u.last_name,
        idType: u.id_type,
        idNumber: u.id_number,
        locale: u.locale,
        status: u.status,
        mfaEnabled: u.mfa_enabled,
        emailVerifiedAt: iso(u.email_verified_at),
        lastLoginAt: iso(u.last_login_at),
        createdAt: iso(u.created_at),
      },
      roles: roles.map((r) => r.code),
      consents: consents.map((c) => ({
        purpose: c.purpose,
        granted: c.granted,
        policyVersion: c.policy_version,
        createdAt: iso(c.created_at),
        ip: c.ip,
      })),
      sessions: sessions.map((t) => ({
        createdAt: iso(t.created_at),
        expiresAt: iso(t.expires_at),
        revokedAt: iso(t.revoked_at),
        userAgent: t.user_agent,
        ip: t.ip,
      })),
    };
  }

  override async anonymize(s: DataSubject): Promise<AnonymizationResult> {
    const ownUser = `user_id IN (SELECT id FROM iam.users WHERE tenant_id = $1 AND id = $2)`;
    const results = [
      await this.db.query(
        `UPDATE iam.users
            SET email = 'anonimizado+' || id || '@anonimizado.invalid',
                phone = NULL, first_name = NULL, last_name = NULL, id_type = NULL, id_number = NULL,
                password_hash = NULL, mfa_secret_enc = NULL, mfa_enabled = false,
                failed_logins = 0, locked_until = NULL,
                status = 'anonymized', deleted_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [s.tenantId, s.userId],
      ),
      await this.db.query(`DELETE FROM iam.refresh_tokens WHERE ${ownUser}`, [s.tenantId, s.userId]),
      await this.db.query(`DELETE FROM iam.user_identities WHERE ${ownUser}`, [s.tenantId, s.userId]),
      await this.db.query(`DELETE FROM iam.user_roles WHERE ${ownUser}`, [s.tenantId, s.userId]),
      await this.db.query(`UPDATE iam.consents SET ip = NULL, guest_email = NULL WHERE ${ownUser}`, [s.tenantId, s.userId]),
    ];
    return {
      affected: results.reduce((n, r) => n + (r.rowCount ?? 0), 0),
      retained: ['Historial de consentimientos (sin IP): prueba de que cada tratamiento fue autorizado o revocado'],
    };
  }
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}
