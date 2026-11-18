import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../apps/api/app.module';
import { configureApp } from '../../apps/api/configure-app';
import { Database, JsonLogger } from '../../libs/shared-kernel';
import { createTenant, TestTenant, tokenFor } from '../support/fixtures';

/**
 * Logs estructurados de la API (docs: backend/README.md, Observabilidad): cada request deja una
 * línea JSON de acceso con el mismo request_id que va en X-Request-Id, el tenant y el usuario, y
 * la ruta como plantilla (sin ids ni tokens de la URL).
 */
describe('Observabilidad: logs JSON con request_id', () => {
  let app: INestApplication;
  let t: TestTenant;
  const lines: Array<Record<string, unknown>> = [];
  const server = () => app.getHttpServer();
  const accessLines = (requestId: string) => lines.filter((l) => l.context === 'HTTP' && l.request_id === requestId);

  beforeAll(async () => {
    const logger = new JsonLogger('moda-api', { write: (line) => lines.push(JSON.parse(line)) });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication({ logger, rawBody: true }));
    await app.init();
    t = await createTenant(app.get(Database));
  });

  afterAll(async () => {
    await app.close();
  });

  it('la línea de acceso lleva el request_id de X-Request-Id, el tenant, el usuario y la ruta plantilla', async () => {
    const requestId = `test-${randomUUID()}`;
    const orderId = randomUUID();
    const res = await request(server())
      .get(`/v1/me/orders/${orderId}`)
      .set('Authorization', `Bearer ${tokenFor(t)}`)
      .set('X-Tenant-Id', t.tenantId)
      .set('X-Request-Id', requestId);
    expect(res.headers['x-request-id']).toBe(requestId);

    await waitFor(() => accessLines(requestId).length > 0);
    const [line] = accessLines(requestId);
    expect(line).toMatchObject({
      level: res.status >= 500 ? 'error' : 'info',
      service: 'moda-api',
      http_method: 'GET',
      http_route: '/v1/me/orders/:id',
      http_status: res.status,
      tenant_id: t.tenantId,
      user_id: t.userId,
    });
    expect(typeof line.duration_ms).toBe('number');
    // El id real de la URL no queda en el log.
    expect(JSON.stringify(line)).not.toContain(orderId);
  });

  it('sin X-Request-Id la API genera uno y es el mismo en la respuesta y en el log', async () => {
    const res = await request(server()).get('/v1/me/orders').expect(401);
    const requestId = res.headers['x-request-id'];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => accessLines(requestId).length > 0);
    expect(accessLines(requestId)[0]).toMatchObject({ http_status: 401, http_route: '/v1/me/orders' });
    expect(accessLines(requestId)[0]).not.toHaveProperty('user_id');
  });

  it('los demás logs del mismo request también llevan su request_id (evento de seguridad del 401)', async () => {
    const requestId = `test-${randomUUID()}`;
    await request(server()).get('/v1/me/orders').set('X-Request-Id', requestId).expect(401);
    await waitFor(() => accessLines(requestId).length > 0);
    const others = lines.filter((l) => l.request_id === requestId && l.context !== 'HTTP');
    expect(others.length).toBeGreaterThan(0);
  });

  it('el healthcheck exitoso no deja línea de acceso (Docker y Uptime Kuma lo llaman cada 30-60 s)', async () => {
    const requestId = `test-${randomUUID()}`;
    await request(server()).get('/v1/health').set('X-Request-Id', requestId).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(accessLines(requestId)).toHaveLength(0);
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout esperando el log');
    await new Promise((r) => setTimeout(r, 10));
  }
}
