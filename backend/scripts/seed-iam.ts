/**
 * IAM de desarrollo: un usuario por rol del sistema, todos con la misma contraseña (SOLO
 * desarrollo, documentada en el README). Reutiliza bodega@, cliente@ y moto@ del seed principal.
 * Idempotente: re-ejecutarlo vuelve a fijar la contraseña y los roles.
 */
import type { INestApplicationContext } from '@nestjs/common';
// Internos de IAM: un script de desarrollo puede usarlos (como los tests).
import { PasswordHasher, SecretBox } from '../libs/modules/iam/application/ports';
import { RoleService } from '../libs/modules/iam/application/role.service';
import { SystemRoleCode } from '../libs/modules/iam/domain/system-roles';
import { base32Decode, otpauthUri } from '../libs/modules/iam/domain/totp';
import { APP_CONFIG, AppConfig, Database } from '../libs/shared-kernel';

export const DEV_PASSWORD = 'Demo-2026-segura';

/**
 * Secreto TOTP FIJO del admin de desarrollo (base32 de "moda-demo-admin-2fa!"). Cárgalo en una
 * app autenticadora (Aegis, FreeOTP, Google Authenticator) con la URI que imprime el seed. Un
 * secreto publicado en el README no protege nada: SOLO para probar el login en dos pasos.
 */
export const DEV_ADMIN_TOTP_SECRET = 'NVXWIYJNMRSW23ZNMFSG22LOFUZGMYJB';

export const DEV_USERS: { role: SystemRoleCode; email: string; type: 'staff' | 'rider' | 'customer'; firstName: string; lastName: string }[] = [
  { role: 'admin', email: 'admin@demo.test', type: 'staff', firstName: 'Andrea', lastName: 'Salazar' },
  { role: 'manager', email: 'gerente@demo.test', type: 'staff', firstName: 'Jorge', lastName: 'Villacís' },
  { role: 'seller', email: 'vendedor@demo.test', type: 'staff', firstName: 'Lucía', lastName: 'Cevallos' },
  { role: 'warehouse', email: 'bodega@demo.test', type: 'staff', firstName: 'Bodega', lastName: 'Quito Norte' },
  { role: 'rider', email: 'moto@demo.test', type: 'rider', firstName: 'Carlos', lastName: 'Andrade' },
  { role: 'support', email: 'soporte@demo.test', type: 'staff', firstName: 'Diana', lastName: 'Mera' },
  { role: 'customer', email: 'cliente@demo.test', type: 'customer', firstName: 'María', lastName: 'Loor' },
  { role: 'logistics', email: 'logistica@demo.test', type: 'staff', firstName: 'Pablo', lastName: 'Guerrero' },
];

/** URI otpauth:// del admin de desarrollo (para el QR o para pegarla en la app autenticadora). */
export function devAdminOtpauthUri(app: INestApplicationContext): string {
  const config = app.get<AppConfig>(APP_CONFIG);
  return otpauthUri(config.iam.mfaIssuer, 'admin@demo.test', base32Decode(DEV_ADMIN_TOTP_SECRET));
}

export async function seedIam(app: INestApplicationContext, tenantId: string): Promise<Record<string, string>> {
  const db = app.get(Database);
  const roles = app.get(RoleService);
  const passwordHash = await app.get(PasswordHasher).hash(DEV_PASSWORD);
  const adminSecret = await app.get(SecretBox).seal(base32Decode(DEV_ADMIN_TOTP_SECRET));
  const ids: Record<string, string> = {};

  await db.withTransaction(async (tx) => {
    await roles.ensureSystemRoles(tx, tenantId);
    for (const u of DEV_USERS) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO iam.users (tenant_id, user_type, email, password_hash, first_name, last_name, phone, status, email_verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, '0991234567', 'active', now())
         ON CONFLICT (tenant_id, email) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, status = 'active', failed_logins = 0, locked_until = NULL,
               first_name = COALESCE(iam.users.first_name, EXCLUDED.first_name),
               last_name = COALESCE(iam.users.last_name, EXCLUDED.last_name)
         RETURNING id`,
        [tenantId, u.type, u.email, passwordHash, u.firstName, u.lastName],
      );
      ids[u.role] = rows[0].id;
      await roles.grantInitialRole(tx, tenantId, rows[0].id, u.role);
      // El rol admin exige 2FA: el admin de desarrollo lo trae activo con el secreto fijo.
      if (u.role === 'admin') {
        await tx.query(`UPDATE iam.users SET mfa_enabled = true, mfa_secret_enc = $2 WHERE id = $1`, [rows[0].id, adminSecret]);
      }
      // El cliente, como si se hubiera registrado por la API: términos y privacidad aceptados (una vez).
      if (u.role === 'customer') {
        await tx.query(
          `INSERT INTO iam.consents (user_id, purpose, policy_version, granted)
           SELECT $1, p, $2, true FROM unnest(ARRAY['terms', 'privacy']) AS p
            WHERE NOT EXISTS (SELECT 1 FROM iam.consents WHERE user_id = $1 AND purpose = p)`,
          [rows[0].id, app.get<AppConfig>(APP_CONFIG).iam.policyVersion],
        );
      }
    }
  });
  return ids;
}
