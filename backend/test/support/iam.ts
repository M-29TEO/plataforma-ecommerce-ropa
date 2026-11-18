/** Helpers de IAM para los tests HTTP: registrar clientes, crear usuarios con rol e iniciar sesión (con 2FA). */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PasswordHasher, SecretBox } from '../../libs/modules/iam/application/ports';
import { RoleService } from '../../libs/modules/iam/application/role.service';
import { SystemRoleCode, findSystemRole } from '../../libs/modules/iam/domain/system-roles';
import { generateTotpSecret, hotp, totpStep } from '../../libs/modules/iam/domain/totp';
import { Database } from '../../libs/shared-kernel';

type Server = Parameters<typeof request>[0];

export const TEST_PASSWORD = 'clave-segura-123';

/** Consentimientos mínimos para registrarse: términos y privacidad. */
export const REQUIRED_CONSENTS = { terms: true, privacy: true };

export function registrationBody(email: string, password: string, extra: Record<string, unknown> = {}) {
  return { email, password, firstName: 'Ana', lastName: 'Pérez', phone: '0991234567', consents: REQUIRED_CONSENTS, ...extra };
}

/** Registra un cliente por la API y devuelve su id. */
export async function registerCustomer(server: Server, tenantId: string, email: string, password: string): Promise<string> {
  const res = await request(server).post('/v1/auth/register').set('X-Tenant-Id', tenantId).send(registrationBody(email, password));
  if (res.status !== 201) throw new Error(`Registro falló (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.id;
}

export interface TestUser {
  id: string;
  email: string;
  /** Secreto TOTP si el usuario tiene 2FA activo (los admin siempre). */
  totpSecret?: Buffer;
}

/** Activa el 2FA de un usuario directamente en la base (secreto cifrado con la SecretBox de la app). */
export async function enableMfa(app: INestApplication, userId: string, secret = generateTotpSecret()): Promise<Buffer> {
  const sealed = await app.get(SecretBox).seal(secret);
  await app.get(Database).query(`UPDATE iam.users SET mfa_enabled = true, mfa_secret_enc = $2 WHERE id = $1`, [userId, sealed]);
  return secret;
}

/**
 * Crea un usuario activo con contraseña (TEST_PASSWORD) y el rol indicado; el tipo sale del rol.
 * Un admin queda con 2FA activo (es obligatorio para su rol), salvo que withMfa = false.
 */
export async function createUserWithRole(
  app: INestApplication,
  tenantId: string,
  role: SystemRoleCode,
  opts: { withMfa?: boolean } = {},
): Promise<TestUser> {
  const db = app.get(Database);
  const email = `${role}+${randomUUID().slice(0, 8)}@example.test`;
  const hash = await app.get(PasswordHasher).hash(TEST_PASSWORD);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO iam.users (tenant_id, user_type, email, password_hash, first_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantId, findSystemRole(role)!.userType, email, hash, role],
  );
  await app.get(RoleService).grantInitialRole(db, tenantId, rows[0].id, role);
  const user: TestUser = { id: rows[0].id, email };
  if (opts.withMfa ?? role === 'admin') user.totpSecret = await enableMfa(app, user.id);
  return user;
}

/**
 * Código TOTP aún no usado para ese secreto: el servidor rechaza repetir un paso (anti-replay), así
 * que si el paso actual ya se usó en este archivo se toma el siguiente (la ventana acepta ±1).
 */
const usedSteps = new Map<string, Set<number>>();
export function freshTotp(secret: Buffer, now = new Date()): string {
  const key = secret.toString('hex');
  const used = usedSteps.get(key) ?? new Set<number>();
  usedSteps.set(key, used);
  const current = totpStep(now);
  const step = [current, current + 1, current - 1].find((s) => !used.has(s));
  if (step === undefined) throw new Error('Sin pasos TOTP libres en la ventana: espera 30 s');
  used.add(step);
  return hotp(secret, step);
}

/** Login con contraseña (y, si el usuario tiene 2FA, con el código); devuelve el access token. */
export async function loginAs(server: Server, tenantId: string, user: TestUser | string, password = TEST_PASSWORD): Promise<string> {
  const email = typeof user === 'string' ? user : user.email;
  const res = await request(server).post('/v1/auth/login').set('X-Tenant-Id', tenantId).send({ email, password });
  if (res.status === 200 && res.body.mfaRequired) {
    const secret = typeof user === 'string' ? undefined : user.totpSecret;
    if (!secret) throw new Error(`${email} exige 2FA y el test no tiene su secreto`);
    const mfa = await request(server).post('/v1/auth/login/mfa').send({ mfaToken: res.body.mfaToken, code: freshTotp(secret) });
    if (mfa.status !== 200) throw new Error(`2FA falló (${mfa.status}): ${JSON.stringify(mfa.body)}`);
    return mfa.body.accessToken;
  }
  if (res.status !== 200 || !res.body.accessToken) throw new Error(`Login falló (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}
