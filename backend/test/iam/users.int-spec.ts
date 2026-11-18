import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { Database } from '../../libs/shared-kernel';
import { createTenant, TestTenant } from '../support/fixtures';
import { createUserWithRole, loginAs, TEST_PASSWORD, TestUser } from '../support/iam';
import { createTestApp } from '../support/test-app';

/**
 * Gestión de usuarios del backoffice (/v1/iam/users): listado con filtros, ficha, alta de personal
 * con contraseña temporal, bloqueo/desbloqueo y reseteo de contraseña, con auditoría. HTTP + PostgreSQL.
 */
describe('Gestión de usuarios (integración)', () => {
  let app: INestApplication;
  let db: Database;
  let t: TestTenant;
  let admin: TestUser;
  let adminToken: string;
  let managerToken: string;
  let sellerToken: string;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    t = await createTenant(db);
    admin = await createUserWithRole(app, t.tenantId, 'admin');
    adminToken = await loginAs(server(), t.tenantId, admin);
    managerToken = await loginAs(server(), t.tenantId, await createUserWithRole(app, t.tenantId, 'manager'));
    sellerToken = await loginAs(server(), t.tenantId, await createUserWithRole(app, t.tenantId, 'seller'));
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const asAdmin = () => bearer(adminToken);
  const uniqueEmail = (prefix: string) => `${prefix}+${randomUUID().slice(0, 8)}@example.test`;

  const login = (email: string, password: string, tenantId = t.tenantId) =>
    request(server()).post('/v1/auth/login').set('X-Tenant-Id', tenantId).send({ email, password });

  /** Login sin 2FA que devuelve la cookie del refresh token. */
  async function loginWithCookie(email: string, password = TEST_PASSWORD): Promise<string> {
    const res = await login(email, password).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token='))!.split(';')[0];
  }

  const refresh = (cookie: string) => request(server()).post('/v1/auth/refresh').set('Cookie', cookie);

  async function auditOf(userId: string) {
    const { rows } = await db.query<{ action: string; actor_id: string; before: unknown; after: Record<string, unknown> }>(
      `SELECT action, actor_id, before, after FROM platform.audit_log WHERE entity_type = 'user' AND entity_id = $1 ORDER BY id`,
      [userId],
    );
    return rows;
  }

  describe('listado y ficha', () => {
    let own: TestTenant;
    let token: string;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      own = await createTenant(db);
      const ownAdmin = await createUserWithRole(app, own.tenantId, 'admin');
      token = await loginAs(server(), own.tenantId, ownAdmin);
      ids.admin = ownAdmin.id;
      ids.warehouse = (await createUserWithRole(app, own.tenantId, 'warehouse')).id;
      ids.rider = (await createUserWithRole(app, own.tenantId, 'rider')).id;
      ids.customer = (await createUserWithRole(app, own.tenantId, 'customer')).id;
      ids.blocked = (await createUserWithRole(app, own.tenantId, 'seller')).id;
      ids.anonymized = (await createUserWithRole(app, own.tenantId, 'customer')).id;
      ids.deleted = (await createUserWithRole(app, own.tenantId, 'customer')).id;
      await db.query(`UPDATE iam.users SET status = 'blocked' WHERE id = $1`, [ids.blocked]);
      await db.query(`UPDATE iam.users SET status = 'anonymized' WHERE id = $1`, [ids.anonymized]);
      await db.query(`UPDATE iam.users SET deleted_at = now() WHERE id = $1`, [ids.deleted]);
      await db.query(`UPDATE iam.users SET first_name = 'Zoila', last_name = 'Paz_100%', phone = '0987654321' WHERE id = $1`, [ids.warehouse]);
      // Orden determinista por fecha de alta: el cliente es el más reciente.
      await db.query(`UPDATE iam.users SET created_at = now() - interval '1 day' WHERE tenant_id = $1`, [own.tenantId]);
      await db.query(`UPDATE iam.users SET created_at = now() WHERE id = $1`, [ids.customer]);
    });

    const list = (query: Record<string, string | number> = {}) => request(server()).get('/v1/iam/users').query(query).set(bearer(token));

    it('lista sin borrados ni anonimizados, más recientes primero, con la forma UserAdminView', async () => {
      const res = await list().expect(200);
      const got = res.body.items.map((u: { id: string }) => u.id);
      expect(got).not.toContain(ids.anonymized);
      expect(got).not.toContain(ids.deleted);
      // fixture de createTenant (staff sin contraseña) + admin, warehouse, rider, customer, blocked
      expect(res.body.total).toBe(6);
      expect(got[0]).toBe(ids.customer);

      const wh = res.body.items.find((u: { id: string }) => u.id === ids.warehouse);
      expect(wh).toEqual({
        id: ids.warehouse,
        type: 'staff',
        email: expect.stringMatching(/^warehouse\+/),
        firstName: 'Zoila',
        lastName: 'Paz_100%',
        phone: '0987654321',
        status: 'active',
        mfaEnabled: false,
        roles: ['warehouse'],
        lastLoginAt: null,
        createdAt: expect.any(String),
      });
      const ad = res.body.items.find((u: { id: string }) => u.id === ids.admin);
      expect(ad).toMatchObject({ roles: ['admin'], mfaEnabled: true, lastLoginAt: expect.any(String) });
    });

    it('filtra por tipo, estado y rol; pagina con limit/offset y total', async () => {
      const riders = await list({ type: 'rider' }).expect(200);
      expect(riders.body.items.map((u: { id: string }) => u.id)).toEqual([ids.rider]);

      const blocked = await list({ status: 'blocked' }).expect(200);
      expect(blocked.body).toMatchObject({ total: 1, items: [{ id: ids.blocked, status: 'blocked', roles: ['seller'] }] });

      const byRole = await list({ role: 'warehouse' }).expect(200);
      expect(byRole.body.items.map((u: { id: string }) => u.id)).toEqual([ids.warehouse]);

      const staffActive = await list({ type: 'staff', status: 'active' }).expect(200);
      expect(staffActive.body.total).toBe(3); // fixture, admin, warehouse

      const page = await list({ limit: 2, offset: 1 }).expect(200);
      expect(page.body.total).toBe(6);
      expect(page.body.items).toHaveLength(2);
      const all = await list({ limit: 100 }).expect(200);
      expect(page.body.items.map((u: { id: string }) => u.id)).toEqual(all.body.items.slice(1, 3).map((u: { id: string }) => u.id));
    });

    it('busca por email, nombre, apellido o teléfono, y trata % y _ como texto literal', async () => {
      for (const q of ['zoila', 'PAZ_100', '0987654', 'warehouse+']) {
        const res = await list({ q }).expect(200);
        expect(res.body.items.map((u: { id: string }) => u.id)).toEqual([ids.warehouse]);
      }
      const percent = await list({ q: '%' }).expect(200);
      expect(percent.body.items.map((u: { id: string }) => u.id)).toEqual([ids.warehouse]); // solo el apellido con un % real
      const underscore = await list({ q: '_' }).expect(200);
      expect(underscore.body.items.map((u: { id: string }) => u.id)).toEqual([ids.warehouse]);
    });

    it('valida los filtros (400)', async () => {
      await list({ type: 'admin' }).expect(400);
      await list({ status: 'anonymized' }).expect(400);
      await list({ limit: 0 }).expect(400);
      await list({ limit: 101 }).expect(400);
      await list({ role: 'DROP TABLE' }).expect(400);
      await list({ desconocido: 1 }).expect(400);
    });

    it('ficha con lockedUntil; 404 si no existe o es de otro tenant', async () => {
      const until = new Date(Date.now() + 10 * 60_000);
      await db.query(`UPDATE iam.users SET locked_until = $2 WHERE id = $1`, [ids.warehouse, until]);
      const res = await request(server()).get(`/v1/iam/users/${ids.warehouse}`).set(bearer(token)).expect(200);
      expect(res.body).toMatchObject({ id: ids.warehouse, roles: ['warehouse'], lockedUntil: until.toISOString() });

      const notFound = await request(server()).get(`/v1/iam/users/${randomUUID()}`).set(bearer(token)).expect(404);
      expect(notFound.body.error.code).toBe('USER_NOT_FOUND');
      await request(server()).get(`/v1/iam/users/${admin.id}`).set(bearer(token)).expect(404); // otro tenant
      await request(server()).get(`/v1/iam/users/${ids.deleted}`).set(bearer(token)).expect(404);
      await request(server()).get('/v1/iam/users/no-es-uuid').set(bearer(token)).expect(400);
    });
  });

  describe('permisos', () => {
    it('manager lee (iam.users.read) pero no escribe; seller ni lee', async () => {
      await request(server()).get('/v1/iam/users').set(bearer(managerToken)).expect(200);
      await request(server()).get(`/v1/iam/users/${admin.id}`).set(bearer(managerToken)).expect(200);
      const body = { email: uniqueEmail('x'), firstName: 'X', lastName: 'Y', roles: ['seller'] };
      await request(server()).post('/v1/iam/users').set(bearer(managerToken)).send(body).expect(403);
      await request(server()).post(`/v1/iam/users/${admin.id}/block`).set(bearer(managerToken)).expect(403);
      await request(server()).post(`/v1/iam/users/${admin.id}/password-reset`).set(bearer(managerToken)).expect(403);

      await request(server()).get('/v1/iam/users').set(bearer(sellerToken)).expect(403);
      await request(server()).get(`/v1/iam/users/${admin.id}`).set(bearer(sellerToken)).expect(403);
      await request(server()).get('/v1/iam/users').expect(401);
    });
  });

  describe('alta de personal', () => {
    it('crea un staff activo con sus roles y contraseña temporal; puede iniciar sesión con ella; queda auditado', async () => {
      const email = uniqueEmail('Nuevo.Vendedor');
      const res = await request(server())
        .post('/v1/iam/users')
        .set(asAdmin())
        .send({ email: `  ${email.toUpperCase()} `, firstName: ' Luis ', lastName: 'Mora', phone: '0991112233', roles: ['seller', 'warehouse', 'seller'] })
        .expect(201);
      const { user, temporaryPassword } = res.body;
      expect(temporaryPassword).toEqual(expect.any(String));
      expect(temporaryPassword.length).toBeGreaterThanOrEqual(16);
      expect(user).toEqual({
        id: expect.any(String),
        type: 'staff',
        email: email.toLowerCase(),
        firstName: 'Luis',
        lastName: 'Mora',
        phone: '0991112233',
        status: 'active',
        mfaEnabled: false,
        roles: ['seller', 'warehouse'],
        lastLoginAt: null,
        createdAt: expect.any(String),
      });

      const session = await login(email, temporaryPassword).expect(200);
      const perms = (jwt.decode(session.body.accessToken) as { perms: string[]; typ: string }).perms;
      expect(perms).toEqual(expect.arrayContaining(['catalog.product.write', 'inventory.adjust']));

      const granted = await db.query<{ granted_by: string }>(`SELECT granted_by FROM iam.user_roles WHERE user_id = $1`, [user.id]);
      expect(granted.rows.map((r) => r.granted_by)).toEqual([admin.id, admin.id]);

      const audit = await auditOf(user.id);
      expect(audit).toEqual([
        {
          action: 'iam.user.created',
          actor_id: admin.id,
          before: null,
          after: { email: email.toLowerCase(), type: 'staff', status: 'active', roles: ['seller', 'warehouse'] },
        },
      ]);
      const leaked = await db.query(`SELECT 1 FROM platform.audit_log WHERE tenant_id = $1 AND (coalesce(before::text, '') || after::text) LIKE $2`, [
        t.tenantId,
        `%${temporaryPassword}%`,
      ]);
      expect(leaked.rows).toHaveLength(0);
    });

    it('un admin creado así debe dar de alta el 2FA en su primer login', async () => {
      const email = uniqueEmail('nuevo-admin');
      const res = await request(server()).post('/v1/iam/users').set(asAdmin()).send({ email, firstName: 'A', lastName: 'B', roles: ['admin'] }).expect(201);
      const first = await login(email, res.body.temporaryPassword).expect(200);
      expect(first.body).toMatchObject({ mfaSetupRequired: true, mfaToken: expect.any(String) });
      expect(first.body).not.toHaveProperty('accessToken');
    });

    it('rechaza roles que no son de staff (422), desconocidos (404) o una lista vacía (400)', async () => {
      const send = (roles: unknown) =>
        request(server()).post('/v1/iam/users').set(asAdmin()).send({ email: uniqueEmail('r'), firstName: 'A', lastName: 'B', roles });
      const customer = await send(['customer']).expect(422);
      expect(customer.body.error.code).toBe('ROLE_NOT_ALLOWED_FOR_USER_TYPE');
      const rider = await send(['seller', 'rider']).expect(422);
      expect(rider.body.error.details).toMatchObject({ role: 'rider', requiredUserType: 'rider', userType: 'staff' });
      const unknown = await send(['superusuario']).expect(404);
      expect(unknown.body.error.code).toBe('ROLE_NOT_FOUND');
      await send([]).expect(400);
      await send('seller').expect(400);
      await request(server()).post('/v1/iam/users').set(asAdmin()).send({ email: 'no-es-email', firstName: 'A', lastName: 'B', roles: ['seller'] }).expect(400);
      await request(server())
        .post('/v1/iam/users')
        .set(asAdmin())
        .send({ email: uniqueEmail('p'), firstName: 'A', lastName: 'B', roles: ['seller'], password: 'elegida-por-mi' })
        .expect(400); // la contraseña no se elige
    });

    it('email repetido (aunque cambie la capitalización): 409 EMAIL_TAKEN y no crea nada', async () => {
      const email = uniqueEmail('dup');
      await request(server()).post('/v1/iam/users').set(asAdmin()).send({ email, firstName: 'A', lastName: 'B', roles: ['support'] }).expect(201);
      const res = await request(server())
        .post('/v1/iam/users')
        .set(asAdmin())
        .send({ email: email.toUpperCase(), firstName: 'C', lastName: 'D', roles: ['support'] })
        .expect(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
      const { rows } = await db.query(`SELECT 1 FROM iam.users WHERE tenant_id = $1 AND email = $2`, [t.tenantId, email]);
      expect(rows).toHaveLength(1);
    });
  });

  describe('bloqueo y desbloqueo', () => {
    it('bloquear corta el login y revoca el refresh; es idempotente; desbloquear lo devuelve; todo auditado', async () => {
      const target = await createUserWithRole(app, t.tenantId, 'seller');
      const cookie = await loginWithCookie(target.email);

      const res = await request(server()).post(`/v1/iam/users/${target.id}/block`).set(asAdmin()).expect(200);
      expect(res.body).toMatchObject({ id: target.id, status: 'blocked', roles: ['seller'] });
      expect(res.body).not.toHaveProperty('lockedUntil');

      expect((await login(target.email, TEST_PASSWORD)).status).toBe(401);
      expect((await refresh(cookie)).status).toBe(401);
      const live = await db.query(`SELECT 1 FROM iam.refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [target.id]);
      expect(live.rows).toHaveLength(0);

      await request(server()).post(`/v1/iam/users/${target.id}/block`).set(asAdmin()).expect(200); // idempotente, sin auditar
      const listed = await request(server()).get('/v1/iam/users').query({ status: 'blocked' }).set(asAdmin()).expect(200);
      expect(listed.body.items.map((u: { id: string }) => u.id)).toContain(target.id);

      const unblocked = await request(server()).post(`/v1/iam/users/${target.id}/unblock`).set(asAdmin()).expect(200);
      expect(unblocked.body.status).toBe('active');
      await login(target.email, TEST_PASSWORD).expect(200);

      expect(await auditOf(target.id)).toEqual([
        { action: 'iam.user.blocked', actor_id: admin.id, before: { status: 'active' }, after: { status: 'blocked', revokedSessions: 1 } },
        { action: 'iam.user.unblocked', actor_id: admin.id, before: { status: 'blocked' }, after: { status: 'active' } },
      ]);
    });

    it('nadie se bloquea ni resetea su propia contraseña (403 CANNOT_MANAGE_OWN_ACCOUNT)', async () => {
      const block = await request(server()).post(`/v1/iam/users/${admin.id}/block`).set(asAdmin()).expect(403);
      expect(block.body.error.code).toBe('CANNOT_MANAGE_OWN_ACCOUNT');
      const reset = await request(server()).post(`/v1/iam/users/${admin.id}/password-reset`).set(asAdmin()).expect(403);
      expect(reset.body.error.code).toBe('CANNOT_MANAGE_OWN_ACCOUNT');
      await request(server()).post(`/v1/iam/users/${admin.id}/unblock`).set(asAdmin()).expect(403);
    });

    it('no se bloquea al último admin activo (409 LAST_ADMIN), aunque se intente con un token viejo', async () => {
      const own = await createTenant(db);
      const a1 = await createUserWithRole(app, own.tenantId, 'admin');
      const a2 = await createUserWithRole(app, own.tenantId, 'admin');
      const a1Token = await loginAs(server(), own.tenantId, a1);
      const a2Token = await loginAs(server(), own.tenantId, a2);

      // a1 bloquea a a2 (queda a1 como único admin activo).
      await request(server()).post(`/v1/iam/users/${a2.id}/block`).set(bearer(a1Token)).expect(200);
      // a2 aún tiene un access token vigente con iam.users.write: intenta dejar al tenant sin admins.
      const res = await request(server()).post(`/v1/iam/users/${a1.id}/block`).set(bearer(a2Token)).expect(409);
      expect(res.body.error.code).toBe('LAST_ADMIN');
      const { rows } = await db.query<{ status: string }>(`SELECT status FROM iam.users WHERE id = $1`, [a1.id]);
      expect(rows[0].status).toBe('active');
    });

    it('cuentas anonimizadas: 422; inexistentes: 404', async () => {
      const gone = await createUserWithRole(app, t.tenantId, 'customer');
      await db.query(`UPDATE iam.users SET status = 'anonymized' WHERE id = $1`, [gone.id]);
      for (const action of ['block', 'unblock', 'password-reset']) {
        const res = await request(server()).post(`/v1/iam/users/${gone.id}/${action}`).set(asAdmin()).expect(422);
        expect(res.body.error.code).toBe('USER_STATUS_NOT_MANAGEABLE');
      }
      await request(server()).post(`/v1/iam/users/${randomUUID()}/block`).set(asAdmin()).expect(404);
      await request(server()).post(`/v1/iam/users/${randomUUID()}/password-reset`).set(asAdmin()).expect(404);
    });
  });

  describe('reseteo de contraseña', () => {
    it('entrega una temporal, invalida la anterior, cierra sesiones, limpia el bloqueo por intentos y audita', async () => {
      const target = await createUserWithRole(app, t.tenantId, 'support');
      const cookie = await loginWithCookie(target.email);
      await db.query(`UPDATE iam.users SET failed_logins = 3, locked_until = now() + interval '10 minutes' WHERE id = $1`, [target.id]);

      const res = await request(server()).post(`/v1/iam/users/${target.id}/password-reset`).set(asAdmin()).expect(200);
      expect(Object.keys(res.body)).toEqual(['temporaryPassword']);
      const { temporaryPassword } = res.body;
      expect(temporaryPassword.length).toBeGreaterThanOrEqual(16);

      const state = await db.query<{ failed_logins: number; locked_until: Date | null }>(
        `SELECT failed_logins, locked_until FROM iam.users WHERE id = $1`,
        [target.id],
      );
      expect(state.rows[0]).toEqual({ failed_logins: 0, locked_until: null });
      expect((await refresh(cookie)).status).toBe(401);
      expect((await login(target.email, TEST_PASSWORD)).status).toBe(401);
      await login(target.email, temporaryPassword).expect(200);

      expect(await auditOf(target.id)).toEqual([
        { action: 'iam.user.password_reset', actor_id: admin.id, before: null, after: { revokedSessions: 1 } },
      ]);
      const leaked = await db.query(`SELECT 1 FROM platform.audit_log WHERE tenant_id = $1 AND (coalesce(before::text, '') || after::text) LIKE $2`, [
        t.tenantId,
        `%${temporaryPassword}%`,
      ]);
      expect(leaked.rows).toHaveLength(0);
    });
  });
});
