import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request, { Response } from 'supertest';
import { Database } from '../../libs/shared-kernel';
import { createTenant, TestTenant } from '../support/fixtures';
import { createTestApp } from '../support/test-app';
import { registerCustomer } from '../support/iam';

/**
 * Sesiones: refresh token opaco en cookie httpOnly, rotación en cada uso, detección de
 * reutilización (revoca la familia), expiración, logout y logout-all. HTTP + PostgreSQL.
 */
describe('Sesiones y refresh tokens (integración)', () => {
  let app: INestApplication;
  let db: Database;
  let t: TestTenant;
  const PASSWORD = 'clave-segura-123';

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    t = await createTenant(db);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  /** Valor de la cookie refresh_token en Set-Cookie ('' si la borró), o undefined si no vino. */
  function refreshCookie(res: Response): { value: string; attrs: string } | undefined {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    const line = raw?.find((c) => c.startsWith('refresh_token='));
    if (!line) return undefined;
    return { value: decodeURIComponent(line.split(';')[0].slice('refresh_token='.length)), attrs: line };
  }

  function setCookie(res: Response, name: string): string | undefined {
    return (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith(`${name}=`));
  }

  async function loginNew(): Promise<{ userId: string; refresh: string; access: string }> {
    const email = `cliente+${randomUUID().slice(0, 8)}@example.test`;
    const userId = await registerCustomer(server(), t.tenantId, email, PASSWORD);
    const res = await request(server())
      .post('/v1/auth/login')
      .set('X-Tenant-Id', t.tenantId)
      .set('User-Agent', 'jest-navegador')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { userId, refresh: refreshCookie(res)!.value, access: res.body.accessToken };
  }

  const refresh = (token: string) => request(server()).post('/v1/auth/refresh').set('Cookie', `refresh_token=${encodeURIComponent(token)}`);

  async function tokenRow(token: string) {
    const hash = createHash('sha256').update(token).digest();
    const { rows } = await db.query<{ id: string; family_id: string; revoked_at: Date | null; user_agent: string | null; expires_at: Date }>(
      `SELECT id, family_id, revoked_at, user_agent, expires_at FROM iam.refresh_tokens WHERE token_hash = $1`,
      [hash],
    );
    return rows[0];
  }

  it('el login entrega el refresh token en una cookie httpOnly, SameSite=Strict, limitada a /v1/auth', async () => {
    const email = `cliente+${randomUUID().slice(0, 8)}@example.test`;
    await registerCustomer(server(), t.tenantId, email, PASSWORD);
    const res = await request(server()).post('/v1/auth/login').set('X-Tenant-Id', t.tenantId).send({ email, password: PASSWORD }).expect(200);

    const cookie = refreshCookie(res)!;
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.attrs).toMatch(/HttpOnly/);
    expect(cookie.attrs).toMatch(/SameSite=Strict/);
    expect(cookie.attrs).toMatch(/Path=\/v1\/auth/);
    expect(res.body).not.toHaveProperty('refreshToken');

    // Indicador no secreto para que el frontend sepa si vale la pena renovar al abrir.
    const hint = setCookie(res, 'session_hint')!;
    expect(hint).toMatch(/^session_hint=1;/);
    expect(hint).not.toMatch(/HttpOnly/);
    expect(hint).toMatch(/Path=\/;/);
    expect(hint).toMatch(/SameSite=Strict/);

    // En la base solo está el hash, nunca el token.
    const row = await tokenRow(cookie.value);
    expect(row).toBeDefined();
    const { rows } = await db.query(`SELECT 1 FROM iam.refresh_tokens WHERE encode(token_hash, 'escape') LIKE $1`, [`%${cookie.value}%`]);
    expect(rows).toHaveLength(0);
    const days = (row.expires_at.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
  });

  describe('rotación normal', () => {
    it('cada refresh entrega un access token y un refresh token nuevos de la misma familia y revoca el anterior', async () => {
      const s = await loginNew();
      const first = await tokenRow(s.refresh);

      const r1 = await refresh(s.refresh).set('User-Agent', 'jest-navegador').expect(200);
      expect(r1.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      const second = refreshCookie(r1)!.value;
      expect(second).not.toBe(s.refresh);

      const oldRow = await tokenRow(s.refresh);
      const newRow = await tokenRow(second);
      expect(oldRow.revoked_at).not.toBeNull();
      expect(newRow).toMatchObject({ family_id: first.family_id, revoked_at: null, user_agent: 'jest-navegador' });

      // El access token nuevo sirve.
      await request(server()).get('/v1/me').set('Authorization', `Bearer ${r1.body.accessToken}`).expect(200);

      // Y la cadena sigue: el sucesor también rota.
      const r2 = await refresh(second).expect(200);
      expect(refreshCookie(r2)!.value).not.toBe(second);
    });

    it('sin cookie o con un token desconocido: 401 REFRESH_TOKEN_INVALID', async () => {
      const none = await request(server()).post('/v1/auth/refresh').expect(401);
      expect(none.body.error.code).toBe('REFRESH_TOKEN_INVALID');
      const unknown = await refresh('token-que-no-existe').expect(401);
      expect(unknown.body.error.code).toBe('REFRESH_TOKEN_INVALID');
      expect(refreshCookie(unknown)?.value).toBe('');
      expect(setCookie(unknown, 'session_hint')).toMatch(/^session_hint=;/);
    });
  });

  describe('reutilización detectada', () => {
    it('presentar un token ya rotado revoca toda la familia, también el sucesor vigente, y queda auditado', async () => {
      const s = await loginNew();
      const familyId = (await tokenRow(s.refresh)).family_id;
      const r1 = await refresh(s.refresh).expect(200);
      const current = refreshCookie(r1)!.value;

      // El atacante (o la víctima) presenta el token viejo.
      const reuse = await refresh(s.refresh).expect(401);
      expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');
      expect(refreshCookie(reuse)?.value).toBe(''); // cookie borrada

      // El token vigente de la familia ya no sirve.
      const after = await refresh(current).expect(401);
      expect(after.body.error.code).toBe('REFRESH_TOKEN_REUSED');
      const { rows } = await db.query<{ open: string }>(
        `SELECT count(*) FILTER (WHERE revoked_at IS NULL) AS open FROM iam.refresh_tokens WHERE family_id = $1`,
        [familyId],
      );
      expect(Number(rows[0].open)).toBe(0);

      const audit = await db.query<{ action: string; actor_type: string; after: { userId: string; revokedTokens: number } }>(
        `SELECT action, actor_type, after FROM platform.audit_log
          WHERE entity_type = 'refresh_token_family' AND entity_id = $1 ORDER BY id`,
        [familyId],
      );
      // Primera reutilización: revoca el sucesor vigente. Segunda (el sucesor ya revocado): nada que revocar.
      expect(audit.rows).toHaveLength(2);
      expect(audit.rows[0]).toMatchObject({ action: 'auth.refresh_reused', actor_type: 'system', after: { userId: s.userId, revokedTokens: 1 } });
      expect(audit.rows[1].after.revokedTokens).toBe(0);
    });

    it('la revocación solo afecta a esa familia: otra sesión del mismo usuario sigue viva', async () => {
      const email = `cliente+${randomUUID().slice(0, 8)}@example.test`;
      await registerCustomer(server(), t.tenantId, email, PASSWORD);
      const login = () => request(server()).post('/v1/auth/login').set('X-Tenant-Id', t.tenantId).send({ email, password: PASSWORD }).expect(200);
      const phone = refreshCookie(await login())!.value;
      const laptop = refreshCookie(await login())!.value;

      await refresh(phone).expect(200);
      await refresh(phone).expect(401); // reutilización en el teléfono

      await refresh(laptop).expect(200);
    });
  });

  describe('token expirado', () => {
    it('responde 401 REFRESH_TOKEN_EXPIRED, lo revoca y borra la cookie', async () => {
      const s = await loginNew();
      await db.query(`UPDATE iam.refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [
        createHash('sha256').update(s.refresh).digest(),
      ]);
      const res = await refresh(s.refresh).expect(401);
      expect(res.body.error.code).toBe('REFRESH_TOKEN_EXPIRED');
      expect(refreshCookie(res)?.value).toBe('');
      expect((await tokenRow(s.refresh)).revoked_at).not.toBeNull();
    });
  });

  it('una cuenta bloqueada por el staff o borrada no renueva la sesión (401 USER_INACTIVE)', async () => {
    const s = await loginNew();
    await db.query(`UPDATE iam.users SET status = 'blocked' WHERE id = $1`, [s.userId]);
    const res = await refresh(s.refresh).expect(401);
    expect(res.body.error.code).toBe('USER_INACTIVE');
  });

  describe('logout', () => {
    it('POST /auth/logout revoca la sesión del dispositivo y borra la cookie (204)', async () => {
      const s = await loginNew();
      const res = await request(server()).post('/v1/auth/logout').set('Cookie', `refresh_token=${s.refresh}`).expect(204);
      expect(refreshCookie(res)?.value).toBe('');
      expect((await tokenRow(s.refresh)).revoked_at).not.toBeNull();
      await refresh(s.refresh).expect(401);
    });

    it('sin cookie también responde 204 (idempotente)', async () => {
      await request(server()).post('/v1/auth/logout').expect(204);
    });

    it('POST /auth/logout-all cierra todas las sesiones del usuario y exige access token', async () => {
      const email = `cliente+${randomUUID().slice(0, 8)}@example.test`;
      await registerCustomer(server(), t.tenantId, email, PASSWORD);
      const sessions = [];
      for (let i = 0; i < 3; i++) {
        const res = await request(server()).post('/v1/auth/login').set('X-Tenant-Id', t.tenantId).send({ email, password: PASSWORD }).expect(200);
        sessions.push({ refresh: refreshCookie(res)!.value, access: res.body.accessToken as string });
      }
      const other = await loginNew();

      await request(server()).post('/v1/auth/logout-all').expect(401);
      const res = await request(server()).post('/v1/auth/logout-all').set('Authorization', `Bearer ${sessions[0].access}`).expect(200);
      expect(res.body).toEqual({ revokedSessions: 3 });

      for (const s of sessions) await refresh(s.refresh).expect(401);
      await refresh(other.refresh).expect(200); // otro usuario, intacto
    });
  });
});
