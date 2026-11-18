import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import request, { Response } from 'supertest';
import { base32Decode, hotp, totpStep } from '../../libs/modules/iam/domain/totp';
import { Database } from '../../libs/shared-kernel';
import { createTenant, TestTenant } from '../support/fixtures';
import { createUserWithRole, freshTotp, loginAs, registrationBody, TEST_PASSWORD, TestUser } from '../support/iam';
import { createTestApp } from '../support/test-app';

/**
 * 2FA TOTP (alta con QR, secreto cifrado, login en dos pasos obligatorio para admin, anti-replay,
 * bloqueo, desactivación y reset) y consentimientos LOPDP del registro. HTTP + PostgreSQL + Valkey.
 */
describe('2FA y consentimientos (integración)', () => {
  let app: INestApplication;
  let db: Database;
  let t: TestTenant;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    t = await createTenant(db);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const login = (email: string, password = TEST_PASSWORD) =>
    request(server()).post('/v1/auth/login').set('X-Tenant-Id', t.tenantId).send({ email, password });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const hasRefreshCookie = (res: Response) =>
    ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).some((c) => /^refresh_token=[^;]+/.test(c));

  async function mfaRow(userId: string) {
    const { rows } = await db.query<{ mfa_enabled: boolean; mfa_secret_enc: Buffer | null; failed_logins: number }>(
      `SELECT mfa_enabled, mfa_secret_enc, failed_logins FROM iam.users WHERE id = $1`,
      [userId],
    );
    return rows[0];
  }

  describe('admin: 2FA obligatorio', () => {
    it('sin 2FA, el login exige darlo de alta: QR, secreto cifrado y activación que abre la sesión', async () => {
      const admin = await createUserWithRole(app, t.tenantId, 'admin', { withMfa: false });

      const step1 = await login(admin.email).expect(200);
      expect(step1.body).toMatchObject({ mfaSetupRequired: true, expiresIn: 300 });
      expect(step1.body).not.toHaveProperty('accessToken');
      expect(hasRefreshCookie(step1)).toBe(false);
      // El mfaToken no sirve como access token.
      await request(server()).get('/v1/me').set(bearer(step1.body.mfaToken)).expect(401);

      const setup = await request(server()).post('/v1/auth/mfa/setup').send({ mfaToken: step1.body.mfaToken }).expect(200);
      expect(setup.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(setup.body.otpauthUrl).toContain('otpauth://totp/Moda%20Demo%3A');
      expect(setup.body.otpauthUrl).toContain(`secret=${setup.body.secret}`);
      const secret = base32Decode(setup.body.secret);
      expect(secret).toHaveLength(20);

      // En la base: cifrado (nonce 24 + MAC 16 + 20 bytes), nunca en claro, y aún pendiente.
      const pending = await mfaRow(admin.id);
      expect(pending.mfa_enabled).toBe(false);
      expect(pending.mfa_secret_enc).toHaveLength(24 + 16 + 20);
      expect(pending.mfa_secret_enc!.includes(secret)).toBe(false);

      const wrong = await request(server()).post('/v1/auth/mfa/activate').send({ mfaToken: step1.body.mfaToken, code: '000000' }).expect(401);
      expect(wrong.body.error.code).toBe('INVALID_MFA_CODE');

      const done = await request(server())
        .post('/v1/auth/mfa/activate')
        .send({ mfaToken: step1.body.mfaToken, code: freshTotp(secret) })
        .expect(200);
      expect(done.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      expect(hasRefreshCookie(done)).toBe(true);
      expect((jwt.decode(done.body.accessToken) as { perms: string[] }).perms).toContain('iam.roles.assign');
      const enabled = await mfaRow(admin.id);
      expect(enabled).toMatchObject({ mfa_enabled: true, failed_logins: 0 });

      const audit = await db.query(`SELECT action FROM platform.audit_log WHERE entity_type = 'user' AND entity_id = $1`, [admin.id]);
      expect(audit.rows).toEqual([{ action: 'iam.mfa.enabled' }]);
      const me = await request(server()).get('/v1/me').set(bearer(done.body.accessToken)).expect(200);
      expect(me.body.mfaEnabled).toBe(true);
    });

    it('con 2FA, el login es en dos pasos: contraseña → mfaToken → código', async () => {
      const admin = await createUserWithRole(app, t.tenantId, 'admin');
      const step1 = await login(admin.email).expect(200);
      expect(step1.body).toMatchObject({ mfaRequired: true });
      expect(hasRefreshCookie(step1)).toBe(false);

      const step2 = await request(server())
        .post('/v1/auth/login/mfa')
        .send({ mfaToken: step1.body.mfaToken, code: freshTotp(admin.totpSecret!) })
        .expect(200);
      expect(hasRefreshCookie(step2)).toBe(true);
      await request(server()).get('/v1/iam/roles').set(bearer(step2.body.accessToken)).expect(200);
    });

    it('un código ya usado no sirve otra vez (anti-replay)', async () => {
      const admin = await createUserWithRole(app, t.tenantId, 'admin');
      const step = totpStep(new Date());
      const code = hotp(admin.totpSecret!, step);

      const first = await login(admin.email).expect(200);
      await request(server()).post('/v1/auth/login/mfa').send({ mfaToken: first.body.mfaToken, code }).expect(200);

      const second = await login(admin.email).expect(200);
      const replay = await request(server()).post('/v1/auth/login/mfa').send({ mfaToken: second.body.mfaToken, code }).expect(401);
      expect(replay.body.error.code).toBe('INVALID_MFA_CODE');
    });

    it('los códigos erróneos cuentan para el bloqueo: al 5.º, 423; la contraseña correcta no reinicia el contador', async () => {
      const admin = await createUserWithRole(app, t.tenantId, 'admin');
      for (let i = 1; i <= 4; i++) {
        const { body } = await login(admin.email).expect(200);
        await request(server()).post('/v1/auth/login/mfa').send({ mfaToken: body.mfaToken, code: '000000' }).expect(401);
        expect((await mfaRow(admin.id)).failed_logins).toBe(i);
      }
      const { body } = await login(admin.email).expect(200);
      const fifth = await request(server()).post('/v1/auth/login/mfa').send({ mfaToken: body.mfaToken, code: '000000' }).expect(423);
      expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');
      // Bloqueada: ni la contraseña ni un código correcto entran.
      await login(admin.email).expect(423);
      await request(server()).post('/v1/auth/login/mfa').send({ mfaToken: body.mfaToken, code: freshTotp(admin.totpSecret!) }).expect(423);
    });

    it('el mfaToken es de un solo propósito, firmado aparte y vence en 5 minutos', async () => {
      const pending = await createUserWithRole(app, t.tenantId, 'admin', { withMfa: false });
      const setupToken = (await login(pending.email).expect(200)).body.mfaToken;
      const r1 = await request(server()).post('/v1/auth/login/mfa').send({ mfaToken: setupToken, code: '123456' }).expect(401);
      expect(r1.body.error.code).toBe('MFA_TOKEN_INVALID');

      const admin = await createUserWithRole(app, t.tenantId, 'admin');
      const loginToken = (await login(admin.email).expect(200)).body.mfaToken;
      await request(server()).post('/v1/auth/mfa/setup').send({ mfaToken: loginToken }).expect(401);

      // Firmado con el secreto del access token (no el del desafío): inválido.
      const forged = jwt.sign({ sub: admin.id, tid: t.tenantId, typ: 'staff', pur: 'mfa-login' }, process.env.JWT_SECRET!, {
        audience: 'iam.mfa',
        expiresIn: 300,
      });
      await request(server()).post('/v1/auth/login/mfa').send({ mfaToken: forged, code: freshTotp(admin.totpSecret!) }).expect(401);

      const claims = jwt.decode(loginToken) as jwt.JwtPayload;
      expect(claims.exp! - claims.iat!).toBe(300);
      expect(claims.aud).toBe('iam.mfa');
    });

    it('un admin no puede desactivar su 2FA (403 MFA_REQUIRED_FOR_ROLE)', async () => {
      const admin = await createUserWithRole(app, t.tenantId, 'admin');
      const token = await loginAs(server(), t.tenantId, admin);
      const res = await request(server()).delete('/v1/me/mfa').set(bearer(token)).send({ code: freshTotp(admin.totpSecret!) }).expect(403);
      expect(res.body.error.code).toBe('MFA_REQUIRED_FOR_ROLE');
    });
  });

  describe('2FA voluntario (cliente) y reset', () => {
    async function customer(): Promise<{ user: TestUser; token: string }> {
      const user = await createUserWithRole(app, t.tenantId, 'customer');
      return { user, token: await loginAs(server(), t.tenantId, user) };
    }

    it('activa desde Mi cuenta, desde entonces el login pide el código, y lo desactiva con un código', async () => {
      const { user, token } = await customer();
      const setup = await request(server()).post('/v1/me/mfa/setup').set(bearer(token)).expect(200);
      const secret = base32Decode(setup.body.secret);

      const bad = await request(server()).post('/v1/me/mfa/activate').set(bearer(token)).send({ code: '000000' }).expect(422);
      expect(bad.body.error.code).toBe('INVALID_MFA_CODE');
      await request(server()).post('/v1/me/mfa/activate').set(bearer(token)).send({ code: freshTotp(secret) }).expect(200);
      await request(server()).post('/v1/me/mfa/setup').set(bearer(token)).expect(409);

      const step1 = await login(user.email).expect(200);
      expect(step1.body.mfaRequired).toBe(true);
      const step2 = await request(server()).post('/v1/auth/login/mfa').send({ mfaToken: step1.body.mfaToken, code: freshTotp(secret) }).expect(200);

      await request(server()).delete('/v1/me/mfa').set(bearer(step2.body.accessToken)).send({ code: '000000' }).expect(422);
      await request(server()).delete('/v1/me/mfa').set(bearer(step2.body.accessToken)).send({ code: freshTotp(secret) }).expect(200);
      expect(await mfaRow(user.id)).toMatchObject({ mfa_enabled: false, mfa_secret_enc: null });
      const plain = await login(user.email).expect(200);
      expect(plain.body.accessToken).toBeDefined();

      const actions = await db.query<{ action: string }>(`SELECT action FROM platform.audit_log WHERE entity_id = $1 ORDER BY id`, [user.id]);
      expect(actions.rows.map((r) => r.action)).toEqual(['iam.mfa.enabled', 'iam.mfa.disabled']);
    });

    it('activar sin haber generado el QR: 422 MFA_SETUP_NOT_STARTED', async () => {
      const { token } = await customer();
      const res = await request(server()).post('/v1/me/mfa/activate').set(bearer(token)).send({ code: '123456' }).expect(422);
      expect(res.body.error.code).toBe('MFA_SETUP_NOT_STARTED');
    });

    it('un admin resetea el 2FA de otro usuario: lo desactiva, cierra sus sesiones y queda auditado', async () => {
      const admin = await createUserWithRole(app, t.tenantId, 'admin');
      const adminToken = await loginAs(server(), t.tenantId, admin);
      const target = await createUserWithRole(app, t.tenantId, 'seller', { withMfa: true });
      const targetLogin = await login(target.email).expect(200);
      const session = await request(server())
        .post('/v1/auth/login/mfa')
        .send({ mfaToken: targetLogin.body.mfaToken, code: freshTotp(target.totpSecret!) })
        .expect(200);
      const cookie = (session.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token='))!.split(';')[0];

      const res = await request(server()).post(`/v1/iam/users/${target.id}/mfa/reset`).set(bearer(adminToken)).expect(200);
      expect(res.body).toEqual({ mfaEnabled: false, revokedSessions: 1 });
      expect(await mfaRow(target.id)).toMatchObject({ mfa_enabled: false, mfa_secret_enc: null });
      await request(server()).post('/v1/auth/refresh').set('Cookie', cookie).expect(401);
      const audit = await db.query<{ action: string; actor_id: string }>(
        `SELECT action, actor_id FROM platform.audit_log WHERE entity_id = $1 AND action = 'iam.mfa.reset'`,
        [target.id],
      );
      expect(audit.rows).toEqual([{ action: 'iam.mfa.reset', actor_id: admin.id }]);

      // Sobre sí mismo: 403. Sin iam.mfa.reset (gerente): 403.
      await request(server()).post(`/v1/iam/users/${admin.id}/mfa/reset`).set(bearer(adminToken)).expect(403);
      const manager = await createUserWithRole(app, t.tenantId, 'manager');
      const managerToken = await loginAs(server(), t.tenantId, manager);
      await request(server()).post(`/v1/iam/users/${target.id}/mfa/reset`).set(bearer(managerToken)).expect(403);
    });
  });

  describe('consentimientos LOPDP del registro', () => {
    const register = (body: Record<string, unknown>) =>
      request(server()).post('/v1/auth/register').set('X-Tenant-Id', t.tenantId).send(body);
    const email = () => `cliente+${randomUUID().slice(0, 8)}@example.test`;

    it('términos y privacidad son obligatorios: sin el bloque, 400; en false, 422 CONSENT_REQUIRED', async () => {
      const noBlock = registrationBody(email(), TEST_PASSWORD) as Record<string, unknown>;
      delete noBlock.consents;
      await register(noBlock).expect(400);

      const rejected = email();
      const res = await register(registrationBody(rejected, TEST_PASSWORD, { consents: { terms: true, privacy: false } })).expect(422);
      expect(res.body.error).toMatchObject({ code: 'CONSENT_REQUIRED', details: { missing: ['privacy'] } });
      // Sin consentimiento no se crea la cuenta.
      const { rows } = await db.query(`SELECT 1 FROM iam.users WHERE tenant_id = $1 AND email = $2`, [t.tenantId, rejected]);
      expect(rows).toHaveLength(0);
    });

    it('guarda términos, privacidad y el marketing elegido con la versión de la política y la IP', async () => {
      const res = await register(
        registrationBody(email(), TEST_PASSWORD, { consents: { terms: true, privacy: true, marketingEmail: true, marketingSms: false } }),
      ).expect(201);
      const { rows } = await db.query<{ purpose: string; granted: boolean; policy_version: string; ip: string | null }>(
        `SELECT purpose, granted, policy_version, ip FROM iam.consents WHERE user_id = $1 ORDER BY id`,
        [res.body.id],
      );
      expect(rows.map((r) => [r.purpose, r.granted])).toEqual([
        ['terms', true],
        ['privacy', true],
        ['marketing_email', true],
        ['marketing_sms', false],
      ]);
      expect(rows.every((r) => r.policy_version === '2026-10' && r.ip !== null)).toBe(true);
    });

    it('el usuario los consulta y modifica; el marketing se revoca, términos y privacidad no', async () => {
      const mail = email();
      await register(registrationBody(mail, TEST_PASSWORD, { consents: { terms: true, privacy: true, marketingWhatsapp: true } })).expect(201);
      const token = await loginAs(server(), t.tenantId, mail);

      const current = await request(server()).get('/v1/me/consents').set(bearer(token)).expect(200);
      const byPurpose = Object.fromEntries(current.body.map((c: { purpose: string; granted: boolean }) => [c.purpose, c.granted]));
      expect(byPurpose).toMatchObject({ terms: true, privacy: true, marketing_whatsapp: true, marketing_email: false });

      const changed = await request(server())
        .put('/v1/me/consents')
        .set(bearer(token))
        .send({ policyVersion: '2026-10', consents: [{ purpose: 'marketing_whatsapp', granted: false }, { purpose: 'marketing_email', granted: true }] })
        .expect(200);
      const after = Object.fromEntries(changed.body.map((c: { purpose: string; granted: boolean }) => [c.purpose, c.granted]));
      expect(after).toMatchObject({ marketing_whatsapp: false, marketing_email: true, privacy: true });

      const revoke = await request(server())
        .put('/v1/me/consents')
        .set(bearer(token))
        .send({ policyVersion: '2026-10', consents: [{ purpose: 'privacy', granted: false }] })
        .expect(422);
      expect(revoke.body.error.code).toBe('CONSENT_NOT_REVOCABLE');

      // El mismo propósito dos veces en un pedido (otorga y revoca a la vez) no es una decisión: 400.
      await request(server())
        .put('/v1/me/consents')
        .set(bearer(token))
        .send({ policyVersion: '2026-10', consents: [{ purpose: 'marketing_sms', granted: true }, { purpose: 'marketing_sms', granted: false }] })
        .expect(400);
    });
  });
});
