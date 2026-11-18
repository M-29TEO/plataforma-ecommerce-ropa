import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { Database } from '../../libs/shared-kernel';
import { createTenant, TestTenant, tokenFor } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

/**
 * Borde HTTP y controles transversales (docs/07-seguridad.md): helmet, CORS, límite del cuerpo,
 * rate limiting con Valkey, auditoría automática y audit_log de solo inserción.
 * Este archivo enciende el rate limiting (global-setup lo apaga para el resto de la suite).
 */
describe('Seguridad: borde HTTP, rate limiting y auditoría', () => {
  let app: INestApplication;
  let db: Database;
  let t: TestTenant;
  let valkey: Redis;
  const server = () => app.getHttpServer();
  /** Cada test usa su propia IP (X-Forwarded-For desde loopback, que es proxy de confianza): contadores aislados. */
  const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.RATE_LIMIT_STORAGE = 'valkey';
    process.env.CORS_ORIGINS = 'https://tienda.moda-demo.test';
    process.env.HTTP_BODY_LIMIT = '100kb';
    ({ app, db } = await createTestApp());
    t = await createTenant(db);
    valkey = new Redis(process.env.VALKEY_URL!);
  });

  afterAll(async () => {
    valkey.disconnect();
    await app.close();
  });

  describe('helmet y cabeceras', () => {
    it('CSP cerrada, sin X-Powered-By, nosniff, sin caché y X-Request-Id', async () => {
      const res = await request(server()).get('/v1/health').expect(200);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('X-Request-Id de Caddy se respeta solo si es seguro de registrar', async () => {
      expect((await request(server()).get('/v1/health').set('X-Request-Id', 'caddy-abc12345')).headers['x-request-id']).toBe('caddy-abc12345');
      const injected = await request(server()).get('/v1/health').set('X-Request-Id', '<script>alert(1)</script>');
      expect(injected.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('CORS estricto', () => {
    it('solo el origen de la lista recibe Access-Control-Allow-Origin (con credenciales)', async () => {
      const ok = await request(server()).options('/v1/cart').set('Origin', 'https://tienda.moda-demo.test').set('Access-Control-Request-Method', 'POST');
      expect(ok.headers['access-control-allow-origin']).toBe('https://tienda.moda-demo.test');
      expect(ok.headers['access-control-allow-credentials']).toBe('true');

      const evil = await request(server()).options('/v1/cart').set('Origin', 'https://evil.test').set('Access-Control-Request-Method', 'POST');
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
      const reflected = await request(server()).get('/v1/health').set('Origin', 'null');
      expect(reflected.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('validación y límites del cuerpo', () => {
    it('un JSON de más de 100 kB responde 413', async () => {
      const big = { email: 'a@b.ec', password: 'x'.repeat(150_000) };
      await request(server()).post('/v1/auth/login').set('X-Forwarded-For', ip()).set('X-Tenant-Id', t.tenantId).send(big).expect(413);
    });

    it('campos de más (prototype pollution, mass assignment) responden 400 sin eco del valor', async () => {
      const res = await request(server())
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip())
        .set('X-Tenant-Id', t.tenantId)
        .set('Content-Type', 'application/json')
        .send('{"email":"a@b.ec","password":"x","isAdmin":true,"__proto__":{"polluted":1}}')
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain('"value"');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('un byte nulo en los filtros responde 400, no 500 (hallazgo de OWASP ZAP)', async () => {
      const staff = `Bearer ${tokenFor(t, ['inventory.read'])}`;
      const res = await request(server()).get('/v1/inventory/warehouses?city=%00').set('Authorization', staff).set('X-Forwarded-For', ip());
      expect([res.status, res.body.error?.code]).toEqual([400, 'INVALID_INPUT']);
      expect((await request(server()).get('/v1/health')).headers['cross-origin-resource-policy']).toBe('same-origin');
    });

    it('el 403 no enumera los permisos que faltan', async () => {
      const res = await request(server()).get('/v1/reports/exports').set('Authorization', `Bearer ${tokenFor(t, [])}`).expect(403);
      expect(JSON.stringify(res.body)).not.toContain('reports.');
    });
  });

  describe('rate limiting (Valkey)', () => {
    it('login: 5 intentos por minuto por IP, compartidos con /auth/login/mfa; el 6.º es 429 con Retry-After', async () => {
      const from = ip();
      const login = () =>
        request(server()).post('/v1/auth/login').set('X-Forwarded-For', from).set('X-Tenant-Id', t.tenantId).send({ email: `${randomUUID()}@x.ec`, password: 'incorrecta-123' });
      for (let i = 0; i < 4; i++) expect((await login()).status).toBe(401);
      // El quinto va a otra ruta del perfil auth: mismo contador.
      expect((await request(server()).post('/v1/auth/login/mfa').set('X-Forwarded-For', from).send({ mfaToken: 'x'.repeat(40), code: '123456' })).status).not.toBe(429);
      const blocked = await login();
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      // Otra IP no está bloqueada.
      expect((await request(server()).post('/v1/auth/login').set('X-Forwarded-For', ip()).set('X-Tenant-Id', t.tenantId).send({ email: 'a@b.ec', password: 'incorrecta-123' })).status).toBe(401);
      // El contador vive en Valkey (compartido entre réplicas), con la IP hasheada.
      // Formato del storage: <prefijo>{<clave>:<ventana>}:hits (las llaves {} fijan el slot en un clúster).
      const keys = await valkey.keys('moda:{rl:auth:*');
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.join()).not.toContain(from);
    });

    it('checkout: 10 por minuto por IP', async () => {
      const from = ip();
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const r = await request(server()).post('/v1/checkout/delivery-options').set('X-Forwarded-For', from).set('X-Tenant-Id', t.tenantId).send({});
        statuses.push(r.status);
      }
      // Cuerpo vacío: 400 de validación (antes, 500 por shippingAddress indefinido).
      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
      expect(statuses[10]).toBe(429);
    });

    it('refresh: perfil propio de 60 por minuto por IP (antes compartía los 10 de lookup y deslogueaba al personal)', async () => {
      const from = ip();
      const statuses: number[] = [];
      for (let i = 0; i < 61; i++) statuses.push((await request(server()).post('/v1/auth/refresh').set('X-Forwarded-For', from)).status);
      expect(statuses.slice(0, 60)).not.toContain(429);
      expect(statuses[60]).toBe(429);
      // Contador propio, separado del de lookup (cupones, gift cards).
      expect(await valkey.keys('moda:{rl:session:*')).not.toHaveLength(0);
    });

    it('global: 120 por minuto por IP en cualquier ruta', async () => {
      const from = ip();
      let last = 0;
      for (let i = 0; i < 121; i++) last = (await request(server()).get('/v1/health').set('X-Forwarded-For', from)).status;
      expect(last).toBe(429);
    });
  });

  describe('auditoría', () => {
    it('una acción @Audited deja actor, IP real, request id y cuerpo; también si falla', async () => {
      const staff = `Bearer ${tokenFor(t, ['notifications.read', 'notifications.templates.write'])}`;
      const from = ip();
      const ok = await request(server())
        .put('/v1/notifications/templates/order.placed/whatsapp/es-EC')
        .set('Authorization', staff)
        .set('X-Forwarded-For', from)
        .send({ body: 'Pedido #{{orderNumber}} confirmado' })
        .expect(200);
      await request(server()).put('/v1/notifications/templates/order.placed/whatsapp/es-EC').set('Authorization', staff).send({ body: '{{#if x}}sin cerrar' }).expect(422);

      const { rows } = await db.query(
        `SELECT actor_id, actor_type, host(actor_ip) AS ip, entity_type, entity_id, request_id, after
           FROM platform.audit_log WHERE tenant_id = $1 AND action = 'notifications.template.upsert' ORDER BY id`,
        [t.tenantId],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ actor_id: t.userId, actor_type: 'staff', ip: from, entity_type: 'notification_template', entity_id: 'order.placed', request_id: ok.headers['x-request-id'] });
      expect(rows[0].after).toMatchObject({ outcome: 'ok', body: { body: 'Pedido #{{orderNumber}} confirmado' } });
      expect(rows[1].after).toMatchObject({ outcome: 'failed', error: 'INVALID_TEMPLATE' });
    });

    it('platform.audit_log es de solo inserción: UPDATE, DELETE y TRUNCATE fallan', async () => {
      await db.query(
        `INSERT INTO platform.audit_log (tenant_id, actor_type, action, entity_type, entity_id) VALUES ($1, 'system', 'test.append_only', 'test', '1')`,
        [t.tenantId],
      );
      await expect(db.query(`UPDATE platform.audit_log SET action = 'x' WHERE tenant_id = $1`, [t.tenantId])).rejects.toThrow(/solo inserción/);
      await expect(db.query(`DELETE FROM platform.audit_log WHERE tenant_id = $1`, [t.tenantId])).rejects.toThrow(/solo inserción/);
      await expect(db.query(`TRUNCATE platform.audit_log`)).rejects.toThrow(/solo inserción/);
    });
  });
});
