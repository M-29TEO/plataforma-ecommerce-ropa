import { INestApplication } from '@nestjs/common';
import { Database, EventBus, OUTBOX_MAX_ATTEMPTS, OutboxRelay, OutboxWriter } from '../../libs/shared-kernel';
import { createTenant, TestTenant } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

describe('Plataforma: transacción ambiental y relay del outbox (PostgreSQL)', () => {
  let app: INestApplication;
  let db: Database;
  let relay: OutboxRelay;
  let bus: EventBus;
  let outbox: OutboxWriter;
  let t: TestTenant;

  beforeAll(async () => {
    ({ app, db, relay } = await createTestApp());
    bus = app.get(EventBus);
    outbox = app.get(OutboxWriter);
    t = await createTenant(db);
  });

  afterAll(async () => {
    await app.close();
  });

  const tenantName = async () => (await db.query(`SELECT name FROM iam.tenants WHERE id = $1`, [t.tenantId])).rows[0].name;

  describe('Database.withTransaction anidado', () => {
    it('las fachadas anidadas usan la misma transacción: un error de afuera revierte también lo de adentro', async () => {
      await expect(
        db.withTransaction(async () => {
          await db.withTransaction((tx) => tx.query(`UPDATE iam.tenants SET name = 'adentro' WHERE id = $1`, [t.tenantId]));
          // Dentro de la transacción, db.query ve lo escrito por la anidada.
          expect(await tenantName()).toBe('adentro');
          throw new Error('falla el orquestador');
        }),
      ).rejects.toThrow('falla el orquestador');
      expect(await tenantName()).not.toBe('adentro');
    });

    it('un error atrapado en la anidada solo revierte su savepoint', async () => {
      await db.withTransaction(async (tx) => {
        await tx.query(`UPDATE iam.tenants SET name = 'externa' WHERE id = $1`, [t.tenantId]);
        await db
          .withTransaction(async (inner) => {
            await inner.query(`UPDATE iam.tenants SET name = 'anidada' WHERE id = $1`, [t.tenantId]);
            await inner.query(`SELECT 1/0`); // aborta: sin savepoint, toda la transacción quedaría inutilizable
          })
          .catch(() => undefined);
        expect(await tenantName()).toBe('externa');
      });
      expect(await tenantName()).toBe('externa');
    });
  });

  describe('OutboxRelay', () => {
    const append = (eventType: string, payload: Record<string, unknown> = {}) =>
      db.withTransaction((tx) =>
        outbox.append(tx, [{ tenantId: t.tenantId, aggregateType: 'test', aggregateId: t.tenantId, eventType, payload }]),
      );
    const row = async (eventType: string) =>
      (await db.query(`SELECT published_at, attempts FROM platform.outbox_events WHERE tenant_id = $1 AND event_type = $2`, [t.tenantId, eventType])).rows[0];

    it('publica en orden y marca published_at junto con los efectos del consumidor', async () => {
      const seen: string[] = [];
      bus.subscribe('PruebaOrden', 'test', async (e) => {
        seen.push(String(e.payload.n));
        await db.query(`UPDATE iam.tenants SET name = $2 WHERE id = $1`, [t.tenantId, `n${e.payload.n}`]);
      });
      await append('PruebaOrden', { n: 1 });
      await append('PruebaOrden', { n: 2 });
      expect(await relay.drain({ tenantId: t.tenantId })).toEqual({ published: 2, failed: 0 });
      expect(seen).toEqual(['1', '2']);
      expect(await tenantName()).toBe('n2');
      expect(await relay.drain({ tenantId: t.tenantId })).toEqual({ published: 0, failed: 0 });
    });

    it('si un consumidor falla se revierte su efecto, suma un intento y se reintenta en la siguiente pasada', async () => {
      let calls = 0;
      bus.subscribe('PruebaFalla', 'test', async () => {
        calls++;
        await db.query(`UPDATE iam.tenants SET name = 'efecto-parcial' WHERE id = $1`, [t.tenantId]);
        if (calls === 1) throw new Error('consumidor caído');
      });
      await append('PruebaFalla');

      expect(await relay.drain({ tenantId: t.tenantId })).toEqual({ published: 0, failed: 1 });
      expect(await row('PruebaFalla')).toMatchObject({ published_at: null, attempts: 1 });
      expect(await tenantName()).not.toBe('efecto-parcial');

      expect(await relay.drain({ tenantId: t.tenantId })).toEqual({ published: 1, failed: 0 });
      expect((await row('PruebaFalla')).published_at).toBeInstanceOf(Date);
      expect(calls).toBe(2);
    });

    it(`tras ${OUTBOX_MAX_ATTEMPTS} intentos fallidos el evento deja de reintentarse`, async () => {
      bus.subscribe('PruebaVeneno', 'test', async () => {
        throw new Error('siempre falla');
      });
      await append('PruebaVeneno');
      for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) await relay.drain({ tenantId: t.tenantId });
      expect(await row('PruebaVeneno')).toMatchObject({ published_at: null, attempts: OUTBOX_MAX_ATTEMPTS });
      expect(await relay.drain({ tenantId: t.tenantId })).toEqual({ published: 0, failed: 0 });
    });
  });
});
