import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { ALL_PERMISSIONS, findSystemRole, SYSTEM_ROLE_CODES, SystemRoleCode } from '../../libs/modules/iam/domain/system-roles';
import { Database } from '../../libs/shared-kernel';
import { createTenant, TestTenant } from '../support/fixtures';
import { createUserWithRole, loginAs, registerCustomer, TEST_PASSWORD, TestUser } from '../support/iam';
import { createTestApp } from '../support/test-app';

/**
 * RBAC: roles del sistema como datos por tenant, permisos en el JWT, @RequirePermission con su
 * PermissionGuard global, asignación de roles por un admin con auditoría. HTTP + PostgreSQL.
 */
describe('RBAC (integración)', () => {
  let app: INestApplication;
  let db: Database;
  let t: TestTenant;
  const users = {} as Record<SystemRoleCode, TestUser>;
  const tokens = {} as Record<SystemRoleCode, string>;
  const ROLES: SystemRoleCode[] = ['admin', 'manager', 'seller', 'warehouse', 'rider', 'support', 'customer', 'logistics'];

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    t = await createTenant(db);
    for (const role of ROLES) {
      users[role] = await createUserWithRole(app, t.tenantId, role);
      tokens[role] = await loginAs(server(), t.tenantId, users[role]);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const as = (role: SystemRoleCode) => ({ Authorization: `Bearer ${tokens[role]}` });

  it('los roles existen como datos en iam.roles (is_system) con sus permisos en iam.role_permissions', async () => {
    const { rows } = await db.query<{ code: string; is_system: boolean; perms: number }>(
      `SELECT r.code, r.is_system, count(rp.permission_code)::int AS perms
         FROM iam.roles r LEFT JOIN iam.role_permissions rp ON rp.role_id = r.id
        WHERE r.tenant_id = $1 GROUP BY r.id ORDER BY r.code`,
      [t.tenantId],
    );
    expect(rows.map((r) => r.code)).toEqual([...ROLES].sort());
    expect(rows.every((r) => r.is_system)).toBe(true);
    for (const r of rows) expect(r.perms).toBe(findSystemRole(r.code)!.permissions.length);
  });

  it('el catálogo de permisos del código coincide con iam.permissions', async () => {
    const { rows } = await db.query<{ code: string }>(`SELECT code FROM iam.permissions ORDER BY code`);
    expect(rows.map((r) => r.code)).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('el JWT lleva exactamente los permisos de los roles del usuario', () => {
    for (const role of ROLES) {
      const claims = jwt.decode(tokens[role]) as { perms: string[]; typ: string };
      expect(new Set(claims.perms)).toEqual(new Set(findSystemRole(role)!.permissions));
      expect(claims.typ).toBe(findSystemRole(role)!.userType);
    }
  });

  it('un cliente registrado recibe el rol customer', async () => {
    const id = await registerCustomer(server(), t.tenantId, `nuevo+${randomUUID().slice(0, 8)}@example.test`, TEST_PASSWORD);
    const { rows } = await db.query<{ code: string }>(
      `SELECT r.code FROM iam.user_roles ur JOIN iam.roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [id],
    );
    expect(rows.map((r) => r.code)).toEqual(['customer']);
  });

  /** Por rol: un endpoint que su rol permite y uno que no (403 del PermissionGuard). */
  const MATRIX: { role: SystemRoleCode; allowed: [string, string]; denied: [string, string] }[] = [
    { role: 'admin', allowed: ['get', '/v1/iam/roles'], denied: ['put', '/v1/iam/users/{self}/roles/seller'] },
    { role: 'manager', allowed: ['get', '/v1/promotions'], denied: ['put', '/v1/iam/users/{self}/roles/seller'] },
    { role: 'seller', allowed: ['get', '/v1/catalog/reviews'], denied: ['post', '/v1/inventory/stock/adjustments'] },
    { role: 'warehouse', allowed: ['get', '/v1/inventory/warehouses'], denied: ['get', '/v1/catalog/reviews'] },
    { role: 'rider', allowed: ['get', '/v1/me'], denied: ['get', '/v1/orders'] },
    { role: 'support', allowed: ['get', '/v1/support/tickets'], denied: ['get', '/v1/reports/sales'] },
    { role: 'customer', allowed: ['get', '/v1/me'], denied: ['get', '/v1/catalog/reviews'] },
    { role: 'logistics', allowed: ['get', '/v1/logistics/settlements'], denied: ['post', '/v1/inventory/stock/adjustments'] },
  ];

  describe.each(MATRIX)('rol $role', ({ role, allowed, denied }) => {
    const path = (p: string) => p.replace('{self}', users[role].id);

    it(`acceso permitido: ${allowed[0].toUpperCase()} ${allowed[1]}`, async () => {
      await request(server())[allowed[0] as 'get'](path(allowed[1])).set(as(role)).expect(200);
    });

    it(`acceso denegado (403): ${denied[0].toUpperCase()} ${denied[1]}`, async () => {
      const res = await request(server())[denied[0] as 'get'](path(denied[1])).set(as(role)).send({});
      expect(res.status).toBe(403);
    });
  });

  it('escritura de Catálogo: moderar exige catalog.reviews.moderate (seller sí, warehouse y support no)', async () => {
    const fakeReview = randomUUID();
    const seller = await request(server()).post(`/v1/catalog/reviews/${fakeReview}/approve`).set(as('seller')).send({});
    expect(seller.status).not.toBe(403); // pasa el guard (404: la reseña no existe)
    for (const role of ['warehouse', 'support', 'customer'] as const) {
      const res = await request(server()).post(`/v1/catalog/reviews/${fakeReview}/approve`).set(as(role)).send({});
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('No tienes permiso para esta operación'); // no enumera el permiso que falta
    }
  });

  describe('asignar y quitar roles (admin)', () => {
    it('asigna, audita y el permiso rige desde el siguiente login', async () => {
      const target = await createUserWithRole(app, t.tenantId, 'warehouse');
      const before = await loginAs(server(), t.tenantId, target);
      await request(server()).get('/v1/catalog/reviews').set('Authorization', `Bearer ${before}`).expect(403);

      const res = await request(server()).put(`/v1/iam/users/${target.id}/roles/seller`).set(as('admin')).expect(200);
      expect(res.body.map((r: { code: string }) => r.code)).toEqual(['seller', 'warehouse']);
      expect(res.body.find((r: { code: string }) => r.code === 'seller').grantedBy).toBe(users.admin.id);

      const audit = await db.query<{ action: string; actor_id: string; actor_type: string; before: unknown; after: unknown }>(
        `SELECT action, actor_id, actor_type, before, after FROM platform.audit_log WHERE entity_type = 'user' AND entity_id = $1 ORDER BY id`,
        [target.id],
      );
      expect(audit.rows).toEqual([
        {
          action: 'iam.role.assigned',
          actor_id: users.admin.id,
          actor_type: 'staff',
          before: { roles: ['warehouse'] },
          after: { roles: ['seller', 'warehouse'], role: 'seller' },
        },
      ]);

      const after = await loginAs(server(), t.tenantId, target);
      await request(server()).get('/v1/catalog/reviews').set('Authorization', `Bearer ${after}`).expect(200);

      // Idempotente: asignar de nuevo no cambia nada ni audita otra vez.
      await request(server()).put(`/v1/iam/users/${target.id}/roles/seller`).set(as('admin')).expect(200);
      const again = await db.query(`SELECT 1 FROM platform.audit_log WHERE entity_type = 'user' AND entity_id = $1`, [target.id]);
      expect(again.rows).toHaveLength(1);
    });

    it('quita, audita y el refresh entrega un token sin el permiso', async () => {
      const target = await createUserWithRole(app, t.tenantId, 'seller');
      const login = await request(server()).post('/v1/auth/login').set('X-Tenant-Id', t.tenantId).send({ email: target.email, password: TEST_PASSWORD }).expect(200);
      const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token='))!.split(';')[0];

      const res = await request(server()).delete(`/v1/iam/users/${target.id}/roles/seller`).set(as('admin')).expect(200);
      expect(res.body).toEqual([]);
      const audit = await db.query<{ action: string; after: unknown }>(
        `SELECT action, after FROM platform.audit_log WHERE entity_type = 'user' AND entity_id = $1`,
        [target.id],
      );
      expect(audit.rows).toEqual([{ action: 'iam.role.removed', after: { roles: [], role: 'seller' } }]);

      const refreshed = await request(server()).post('/v1/auth/refresh').set('Cookie', cookie).expect(200);
      expect((jwt.decode(refreshed.body.accessToken) as { perms: string[] }).perms).toEqual([]);
      await request(server()).get('/v1/catalog/reviews').set('Authorization', `Bearer ${refreshed.body.accessToken}`).expect(403);
    });

    it('lista roles del tenant y de un usuario (iam.roles.read)', async () => {
      const roles = await request(server()).get('/v1/iam/roles').set(as('manager')).expect(200);
      expect(roles.body).toHaveLength(SYSTEM_ROLE_CODES.length);
      expect(roles.body.find((r: { code: string }) => r.code === 'seller').permissions).toContain('catalog.product.write');
      const mine = await request(server()).get(`/v1/iam/users/${users.support.id}/roles`).set(as('manager')).expect(200);
      expect(mine.body.map((r: { code: string }) => r.code)).toEqual(['support']);
      // manager lee pero no asigna.
      await request(server()).put(`/v1/iam/users/${users.support.id}/roles/seller`).set(as('manager')).expect(403);
    });

    it('nadie cambia sus propios roles (403 CANNOT_CHANGE_OWN_ROLES)', async () => {
      const res = await request(server()).delete(`/v1/iam/users/${users.admin.id}/roles/admin`).set(as('admin')).expect(403);
      expect(res.body.error.code).toBe('CANNOT_CHANGE_OWN_ROLES');
    });

    it('el rol debe corresponder al tipo de usuario (422), existir (404) y estar asignado para quitarlo (404)', async () => {
      const toCustomer = await request(server()).put(`/v1/iam/users/${users.customer.id}/roles/admin`).set(as('admin')).expect(422);
      expect(toCustomer.body.error.code).toBe('ROLE_NOT_ALLOWED_FOR_USER_TYPE');
      const toStaff = await request(server()).put(`/v1/iam/users/${users.seller.id}/roles/rider`).set(as('admin')).expect(422);
      expect(toStaff.body.error.details).toMatchObject({ requiredUserType: 'rider', userType: 'staff' });

      const unknown = await request(server()).put(`/v1/iam/users/${users.seller.id}/roles/superusuario`).set(as('admin')).expect(404);
      expect(unknown.body.error.code).toBe('ROLE_NOT_FOUND');
      const notAssigned = await request(server()).delete(`/v1/iam/users/${users.seller.id}/roles/support`).set(as('admin')).expect(404);
      expect(notAssigned.body.error.code).toBe('ROLE_NOT_ASSIGNED');
      await request(server()).put(`/v1/iam/users/${randomUUID()}/roles/seller`).set(as('admin')).expect(404);

      const other = await createTenant(db);
      const foreign = await createUserWithRole(app, other.tenantId, 'warehouse');
      await request(server()).put(`/v1/iam/users/${foreign.id}/roles/seller`).set(as('admin')).expect(404); // otro tenant
    });

    it('no se quita el último admin activo (409), aunque quien lo intente tenga un token viejo con permisos', async () => {
      const own = await createTenant(db);
      const a1 = await createUserWithRole(app, own.tenantId, 'admin');
      const a2 = await createUserWithRole(app, own.tenantId, 'admin');
      const a1Token = await loginAs(server(), own.tenantId, a1);
      const a2Token = await loginAs(server(), own.tenantId, a2);

      // a1 le quita el admin a a2 (quedan 1 activo: a1).
      await request(server()).delete(`/v1/iam/users/${a2.id}/roles/admin`).set('Authorization', `Bearer ${a1Token}`).expect(200);
      // a2 aún tiene un JWT con iam.roles.assign; intenta dejar al tenant sin admins.
      const res = await request(server()).delete(`/v1/iam/users/${a1.id}/roles/admin`).set('Authorization', `Bearer ${a2Token}`).expect(409);
      expect(res.body.error.code).toBe('LAST_ADMIN');
    });

    it('un admin bloqueado no cuenta: quitarle el rol no choca con la regla del último admin', async () => {
      const own = await createTenant(db);
      const active = await createUserWithRole(app, own.tenantId, 'admin');
      const blocked = await createUserWithRole(app, own.tenantId, 'admin');
      const token = await loginAs(server(), own.tenantId, active);
      await db.query(`UPDATE iam.users SET status = 'blocked' WHERE id = $1`, [blocked.id]);
      await request(server()).delete(`/v1/iam/users/${blocked.id}/roles/admin`).set('Authorization', `Bearer ${token}`).expect(200);
    });
  });
});
