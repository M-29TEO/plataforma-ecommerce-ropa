import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { Database, signAccessToken } from '../../libs/shared-kernel';
import { createTenant, TestTenant } from '../support/fixtures';
import { REQUIRED_CONSENTS } from '../support/iam';
import { createTestApp } from '../support/test-app';

/**
 * IAM: registro con argon2id, login con JWT de 15 min y bloqueo tras 5 fallos, GET /me y el
 * guard global (cerrado por defecto, @Public() para las rutas abiertas). HTTP + PostgreSQL.
 */
describe('Autenticación (integración)', () => {
  let app: INestApplication;
  let db: Database;
  let t: TestTenant;
  let other: TestTenant;
  const PASSWORD = 'clave-segura-123';

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    t = await createTenant(db);
    other = await createTenant(db);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const newEmail = () => `cliente+${randomUUID().slice(0, 8)}@example.test`;

  function register(body: Record<string, unknown>, tenantId = t.tenantId) {
    return request(server())
      .post('/v1/auth/register')
      .set('X-Tenant-Id', tenantId)
      .send({ password: PASSWORD, firstName: 'Ana', lastName: 'Pérez', phone: '0991234567', consents: REQUIRED_CONSENTS, ...body });
  }

  function login(email: string, password: string, tenantId = t.tenantId) {
    return request(server()).post('/v1/auth/login').set('X-Tenant-Id', tenantId).send({ email, password });
  }

  async function registered(): Promise<{ email: string; id: string }> {
    const email = newEmail();
    const res = await register({ email }).expect(201);
    return { email, id: res.body.id };
  }

  async function loginState(userId: string) {
    const { rows } = await db.query<{ failed_logins: number; locked_until: Date | null; last_login_at: Date | null }>(
      `SELECT failed_logins, locked_until, last_login_at FROM iam.users WHERE id = $1`,
      [userId],
    );
    return rows[0];
  }

  describe('POST /v1/auth/register', () => {
    it('crea un cliente activo y guarda la contraseña con argon2id, nunca en claro', async () => {
      const email = newEmail();
      const res = await register({ email: `  ${email.toUpperCase()} `, phone: '+593991234567' }).expect(201);

      expect(res.body).toMatchObject({
        tenantId: t.tenantId,
        type: 'customer',
        email,
        firstName: 'Ana',
        lastName: 'Pérez',
        phone: '+593991234567',
        status: 'active',
        emailVerified: false,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/i);

      const { rows } = await db.query<{ password_hash: string }>(`SELECT password_hash FROM iam.users WHERE id = $1`, [res.body.id]);
      expect(rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(rows[0].password_hash).not.toContain(PASSWORD);
    });

    it('rechaza un email ya registrado en el tenant, aunque cambie la capitalización (409)', async () => {
      const { email } = await registered();
      const res = await register({ email: email.toUpperCase() }).expect(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('permite el mismo email en otro tenant', async () => {
      const { email } = await registered();
      await register({ email }, other.tenantId).expect(201);
    });

    it('rechaza una contraseña de menos de 10 caracteres (422)', async () => {
      const res = await register({ email: newEmail(), password: '123456789' }).expect(422);
      expect(res.body.error).toMatchObject({ code: 'PASSWORD_TOO_SHORT', details: { minLength: 10 } });
    });

    it('acepta exactamente 10 caracteres', async () => {
      await register({ email: newEmail(), password: '1234567890' }).expect(201);
    });

    it('valida el cuerpo: email, teléfono y campos obligatorios (400)', async () => {
      await register({ email: 'no-es-email' }).expect(400);
      await register({ email: newEmail(), phone: '099-123' }).expect(400);
      await register({ email: newEmail(), firstName: '' }).expect(400);
      await register({ email: newEmail(), rol: 'staff' }).expect(400); // forbidNonWhitelisted
    });

    it('exige el header X-Tenant-Id (400) y un tenant activo (422)', async () => {
      await request(server())
        .post('/v1/auth/register')
        .send({ email: newEmail(), password: PASSWORD, firstName: 'A', lastName: 'B', phone: '0991234567', consents: REQUIRED_CONSENTS })
        .expect(400);
      const missing = await register({ email: newEmail() }, randomUUID()).expect(422);
      expect(missing.body.error.code).toBe('TENANT_UNAVAILABLE');

      const suspended = await createTenant(db);
      await db.query(`UPDATE iam.tenants SET status = 'suspended' WHERE id = $1`, [suspended.tenantId]);
      await register({ email: newEmail() }, suspended.tenantId).expect(422);
    });
  });

  describe('POST /v1/auth/login', () => {
    it('devuelve un JWT de acceso de 15 minutos con los claims del usuario', async () => {
      const { email, id } = await registered();
      const res = await login(email.toUpperCase(), PASSWORD).expect(200);

      expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      const claims = jwt.verify(res.body.accessToken, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      expect(claims).toMatchObject({ sub: id, tid: t.tenantId, typ: 'customer', perms: [] });
      expect(claims.exp! - claims.iat!).toBe(15 * 60);
      expect((await loginState(id)).last_login_at).not.toBeNull();
    });

    it('contraseña errónea y email inexistente responden igual (401 INVALID_CREDENTIALS)', async () => {
      const { email } = await registered();
      const wrong = await login(email, 'otra-clave-123').expect(401);
      const unknown = await login(newEmail(), PASSWORD).expect(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('el login es por tenant: en otro tenant el email no existe', async () => {
      const { email } = await registered();
      await login(email, PASSWORD, other.tenantId).expect(401);
    });

    it('cuenta los fallos y un login correcto los reinicia', async () => {
      const { email, id } = await registered();
      for (let i = 0; i < 3; i++) await login(email, 'mala-clave-123').expect(401);
      expect((await loginState(id)).failed_logins).toBe(3);

      await login(email, PASSWORD).expect(200);
      expect((await loginState(id)).failed_logins).toBe(0);
    });

    it('al 5.º fallo bloquea 15 minutos: rechaza incluso la contraseña correcta (423)', async () => {
      const { email, id } = await registered();
      for (let i = 0; i < 4; i++) await login(email, 'mala-clave-123').expect(401);
      const fifth = await login(email, 'mala-clave-123').expect(423);
      expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');

      const state = await loginState(id);
      expect(state.failed_logins).toBe(0);
      const minutes = (new Date(fifth.body.error.details.lockedUntil).getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(14);
      expect(minutes).toBeLessThanOrEqual(15);
      expect(state.locked_until!.toISOString()).toBe(fifth.body.error.details.lockedUntil);

      await login(email, PASSWORD).expect(423);
      // Los intentos durante el bloqueo no lo alargan.
      expect((await loginState(id)).locked_until).toEqual(state.locked_until);
    });

    it('cuando vence el bloqueo vuelve a entrar', async () => {
      const { email, id } = await registered();
      for (let i = 0; i < 5; i++) await login(email, 'mala-clave-123');
      await login(email, PASSWORD).expect(423);

      // Simula que pasaron los 15 minutos.
      await db.query(`UPDATE iam.users SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
      await login(email, PASSWORD).expect(200);
      expect(await loginState(id)).toMatchObject({ failed_logins: 0, locked_until: null });
    });

    it('5 fallos simultáneos no pierden ninguno: la cuenta queda bloqueada', async () => {
      const { email, id } = await registered();
      const results = await Promise.all(Array.from({ length: 5 }, () => login(email, 'mala-clave-123')));
      expect(results.map((r) => r.status).sort()).toEqual([401, 401, 401, 401, 423]);
      const state = await loginState(id);
      expect(state.locked_until!.getTime()).toBeGreaterThan(Date.now());
      await login(email, PASSWORD).expect(423);
    });

    it('cuentas bloqueadas por el staff, anonimizadas, borradas o sin contraseña no entran (401)', async () => {
      const blocked = await registered();
      await db.query(`UPDATE iam.users SET status = 'blocked' WHERE id = $1`, [blocked.id]);
      await login(blocked.email, PASSWORD).expect(401);

      const deleted = await registered();
      await db.query(`UPDATE iam.users SET deleted_at = now() WHERE id = $1`, [deleted.id]);
      await login(deleted.email, PASSWORD).expect(401);

      const noPassword = newEmail();
      await db.query(`INSERT INTO iam.users (tenant_id, user_type, email) VALUES ($1, 'customer', $2)`, [t.tenantId, noPassword]);
      await login(noPassword, PASSWORD).expect(401);
    });

    it('valida el cuerpo (400)', async () => {
      await request(server()).post('/v1/auth/login').set('X-Tenant-Id', t.tenantId).send({ email: 'x' }).expect(400);
    });
  });

  describe('GET /v1/me', () => {
    it('devuelve el usuario del token', async () => {
      const { email, id } = await registered();
      const { body } = await login(email, PASSWORD).expect(200);
      const me = await request(server()).get('/v1/me').set('Authorization', `Bearer ${body.accessToken}`).expect(200);
      expect(me.body).toMatchObject({ id, tenantId: t.tenantId, email, type: 'customer', firstName: 'Ana', phone: '0991234567' });
      expect(me.body).not.toHaveProperty('passwordHash');
    });

    it('sin token, con token inválido o vencido responde 401', async () => {
      await request(server()).get('/v1/me').expect(401);
      await request(server()).get('/v1/me').set('Authorization', 'Bearer no-es-un-jwt').expect(401);
      const { id } = await registered();
      const expired = signAccessToken({ id, tenantId: t.tenantId, type: 'customer', permissions: [] }, process.env.JWT_SECRET!, -10);
      await request(server()).get('/v1/me').set('Authorization', `Bearer ${expired}`).expect(401);
      const forged = signAccessToken({ id, tenantId: t.tenantId, type: 'customer', permissions: [] }, 'otro-secreto');
      await request(server()).get('/v1/me').set('Authorization', `Bearer ${forged}`).expect(401);
    });

    it('si el usuario fue borrado después de emitir el token, 401', async () => {
      const { email, id } = await registered();
      const { body } = await login(email, PASSWORD).expect(200);
      await db.query(`UPDATE iam.users SET deleted_at = now() WHERE id = $1`, [id]);
      const res = await request(server()).get('/v1/me').set('Authorization', `Bearer ${body.accessToken}`).expect(401);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
    });
  });

  describe('guard global (cerrado por defecto)', () => {
    const MISSING_TOKEN = 'Falta el token de acceso';

    it('health es público', async () => {
      const res = await request(server()).get('/v1/health').expect(200);
      expect(res.body).toEqual({ status: 'ok', database: 'up' });
    });

    it('la lectura de reseñas y preguntas del catálogo es pública', async () => {
      for (const path of ['reviews', 'questions']) {
        const res = await request(server()).get(`/v1/products/${randomUUID()}/${path}`).set('X-Tenant-Id', t.tenantId);
        expect(res.status).not.toBe(401);
      }
    });

    it('las rutas anónimas existentes siguen abiertas (webhook, push, invitados)', async () => {
      const webhook = await request(server()).post('/v1/webhooks/payments/simulator').send({ x: 1 });
      expect(webhook.body.message).not.toBe(MISSING_TOKEN); // lo rechaza la firma HMAC, no el guard
      const push = await request(server()).get('/v1/notifications/push/public-key');
      expect(push.status).not.toBe(401);
      const ticket = await request(server()).get('/v1/support/ticket-links/token-falso');
      expect(ticket.body.message).not.toBe(MISSING_TOKEN);
      const cart = await request(server()).get('/v1/cart').set('X-Tenant-Id', t.tenantId);
      expect(cart.status).not.toBe(401);
    });

    it('una ruta autenticada sin token responde 401 por el guard', async () => {
      const res = await request(server()).get('/v1/me/consents').expect(401);
      expect(res.body.message).toBe(MISSING_TOKEN);
    });

    it('un token de cliente sin permisos no pasa @Auth(permiso) (403)', async () => {
      const { email } = await registered();
      const { body } = await login(email, PASSWORD).expect(200);
      await request(server()).get('/v1/orders').set('Authorization', `Bearer ${body.accessToken}`).expect(403);
    });
  });
});
