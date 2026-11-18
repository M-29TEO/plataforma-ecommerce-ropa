import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { STOCK_BELOW_THRESHOLD } from '../../libs/modules/inventory';
import { Database } from '../../libs/shared-kernel';
import {
  createTenant,
  createVariants,
  createWarehouse,
  getStock,
  outboxEvents,
  setStock,
  TestTenant,
  tokenFor,
} from '../support/fixtures';
import { createTestApp } from '../support/test-app';

describe('Inventario · stock, ajustes y ledger (HTTP)', () => {
  let app: INestApplication;
  let db: Database;
  let t: TestTenant;
  let auth: string;
  let warehouseId: string;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    t = await createTenant(db);
    auth = `Bearer ${tokenFor(t)}`;
    warehouseId = await createWarehouse(db, t.tenantId);
  });

  afterAll(async () => {
    await app.close();
  });

  const adjust = (body: Record<string, unknown>, token = auth) =>
    request(app.getHttpServer()).post('/v1/inventory/stock/adjustments').set('Authorization', token).send(body);

  const ledgerSum = async (variantId: string) => {
    const { rows } = await db.query<{ total: number }>(
      `SELECT COALESCE(SUM(quantity), 0)::int AS total FROM inventory.stock_movements WHERE variant_id = $1 AND warehouse_id = $2`,
      [variantId, warehouseId],
    );
    return rows[0].total;
  };

  describe('Ajustes manuales', () => {
    it('exige el permiso inventory.adjust', async () => {
      const [v] = await createVariants(db, t.tenantId, 1);
      const token = `Bearer ${tokenFor(t, ['inventory.read', 'inventory.stock.write'])}`;
      const res = await adjust({ variantId: v, warehouseId, type: 'adjustment', delta: 5, reason: 'Inventario inicial' }, token).expect(403);
      // 403 genérico: no enumera los permisos que faltan (el detalle va al log).
      expect(res.body.message).not.toContain('inventory.adjust');
      expect(await getStock(db, v, warehouseId)).toBeUndefined();
    });

    it('crea la fila de stock, registra el movimiento con el usuario y mantiene ledger = on_hand', async () => {
      const [v] = await createVariants(db, t.tenantId, 1);

      const res = await adjust({ variantId: v, warehouseId, type: 'adjustment', delta: 12, reason: 'Inventario inicial' }).expect(201);
      expect(res.body).toMatchObject({ delta: 12, level: { onHand: 12, reserved: 0, available: 12 } });

      await adjust({ variantId: v, warehouseId, type: 'damage', quantity: 2, reason: 'Prendas manchadas' }).expect(201);
      await adjust({ variantId: v, warehouseId, type: 'count', countedQuantity: 9, reason: 'Conteo cíclico' }).expect(201);

      const { rows } = await db.query(
        `SELECT quantity, movement_type, reason, user_id, reference_type
           FROM inventory.stock_movements WHERE variant_id = $1 ORDER BY id`,
        [v],
      );
      expect(rows).toEqual([
        { quantity: 12, movement_type: 'adjustment', reason: 'Inventario inicial', user_id: t.userId, reference_type: 'manual_adjustment' },
        { quantity: -2, movement_type: 'damage', reason: 'Prendas manchadas', user_id: t.userId, reference_type: 'manual_adjustment' },
        { quantity: -1, movement_type: 'count', reason: 'Conteo cíclico', user_id: t.userId, reference_type: 'manual_adjustment' },
      ]);
      expect((await getStock(db, v, warehouseId)).on_hand).toBe(9);
      expect(await ledgerSum(v)).toBe(9);
    });

    it('no deja menos unidades físicas que las reservadas', async () => {
      const [v] = await createVariants(db, t.tenantId, 1);
      await setStock(db, v, warehouseId, 5, { reserved: 4 });

      const res = await adjust({ variantId: v, warehouseId, type: 'damage', quantity: 2, reason: 'Rotura' }).expect(409);
      expect(res.body.error.code).toBe('ADJUSTMENT_BELOW_RESERVED');
      expect(await getStock(db, v, warehouseId)).toMatchObject({ on_hand: 5, reserved: 4 });
    });

    it('valida el cuerpo según el tipo de ajuste', async () => {
      const [v] = await createVariants(db, t.tenantId, 1);
      await adjust({ variantId: v, warehouseId, type: 'adjustment', reason: 'sin delta' }).expect(400);
      await adjust({ variantId: v, warehouseId, type: 'damage', quantity: 0, reason: 'cero' }).expect(400);
      await adjust({ variantId: v, warehouseId, type: 'adjustment', delta: 1, reason: '' }).expect(400);
      await adjust({ variantId: v, warehouseId, type: 'robo', delta: 1, reason: 'tipo inválido' }).expect(400);
      // delta 0 y cantidades fuera de rango los corta el DTO (antes de tocar la base).
      await adjust({ variantId: v, warehouseId, type: 'adjustment', delta: 0, reason: 'cero' }).expect(400);
      await adjust({ variantId: v, warehouseId, type: 'adjustment', delta: 100_001, reason: 'dedazo' }).expect(400);
      await adjust({ variantId: v, warehouseId, type: 'count', countedQuantity: 1_000_001, reason: 'dedazo' }).expect(400);
    });

    it('rechaza bodegas inactivas y variantes inexistentes', async () => {
      const [v] = await createVariants(db, t.tenantId, 1);
      const inactive = await createWarehouse(db, t.tenantId, { active: false });
      await adjust({ variantId: v, warehouseId: inactive, type: 'adjustment', delta: 1, reason: 'test' }).expect(409);

      const missing = await adjust({
        variantId: '00000000-0000-4000-8000-000000000000',
        warehouseId,
        type: 'adjustment',
        delta: 1,
        reason: 'test',
      }).expect(404);
      expect(missing.body.error.code).toBe('VARIANT_NOT_FOUND');
    });

    it('no opera stock de una variante de otro tenant (product_variants no tiene tenant_id)', async () => {
      const other = await createTenant(db);
      const [foreign] = await createVariants(db, other.tenantId, 1);
      const res = await adjust({ variantId: foreign, warehouseId, type: 'adjustment', delta: 5, reason: 'ajena' }).expect(404);
      expect(res.body.error.code).toBe('VARIANT_NOT_FOUND');
      expect(await getStock(db, foreign, warehouseId)).toBeUndefined();

      // Aunque exista la fila (sembrada por fuera), la configuración tampoco se deja tocar.
      await setStock(db, foreign, warehouseId, 3);
      await request(app.getHttpServer())
        .patch(`/v1/inventory/stock/${foreign}/${warehouseId}`)
        .set('Authorization', auth)
        .send({ version: 0, reorderPoint: 1 })
        .expect(404);
    });

    it('deja el ajuste en la auditoría con el actor', async () => {
      const [v] = await createVariants(db, t.tenantId, 1);
      await adjust({ variantId: v, warehouseId, type: 'adjustment', delta: 2, reason: 'Auditoría' }).expect(201);
      const { rows } = await db.query(
        `SELECT actor_id, after FROM platform.audit_log WHERE tenant_id = $1 AND action = 'inventory.stock.adjust' ORDER BY id DESC LIMIT 1`,
        [t.tenantId],
      );
      expect(rows[0]).toMatchObject({ actor_id: t.userId, after: { outcome: 'ok', body: { variantId: v, delta: 2 } } });
    });

    it('emite StockBelowThreshold vía outbox al cruzar el punto de reorden', async () => {
      const [v] = await createVariants(db, t.tenantId, 1);
      await setStock(db, v, warehouseId, 6, { reorderPoint: 3 });

      await adjust({ variantId: v, warehouseId, type: 'damage', quantity: 2, reason: 'Rotura' }).expect(201); // 4
      await adjust({ variantId: v, warehouseId, type: 'damage', quantity: 2, reason: 'Rotura' }).expect(201); // 2 → cruza
      await adjust({ variantId: v, warehouseId, type: 'damage', quantity: 1, reason: 'Rotura' }).expect(201); // 1

      const events = (await outboxEvents(db, t.tenantId, STOCK_BELOW_THRESHOLD)).filter((e) => e.payload.variantId === v);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ warehouseId, available: 2, reorderPoint: 3, cause: 'adjustment' });
    });
  });

  describe('Consulta y configuración', () => {
    it('lista por bodega (con filtro de bajo reorden), por variante y el detalle', async () => {
      const [low, ok] = await createVariants(db, t.tenantId, 2);
      const wh = await createWarehouse(db, t.tenantId);
      await setStock(db, low, wh, 2, { reorderPoint: 3 });
      await setStock(db, ok, wh, 20, { reorderPoint: 3 });
      const server = app.getHttpServer();

      const all = await request(server).get(`/v1/inventory/stock?warehouseId=${wh}`).set('Authorization', auth).expect(200);
      expect(all.body).toHaveLength(2);

      const lowOnly = await request(server)
        .get(`/v1/inventory/stock?warehouseId=${wh}&belowReorderPoint=true`)
        .set('Authorization', auth)
        .expect(200);
      expect(lowOnly.body.map((s: { variantId: string }) => s.variantId)).toEqual([low]);

      const byVariant = await request(server).get(`/v1/inventory/stock?variantId=${ok}`).set('Authorization', auth).expect(200);
      expect(byVariant.body).toMatchObject([{ warehouseId: wh, onHand: 20, available: 20 }]);

      await request(server).get(`/v1/inventory/stock/${ok}/${wh}`).set('Authorization', auth).expect(200);
      await request(server).get('/v1/inventory/stock').set('Authorization', auth).expect(422);
    });

    it('actualiza la configuración de reposición con concurrencia optimista (version)', async () => {
      const [v] = await createVariants(db, t.tenantId, 1);
      await setStock(db, v, warehouseId, 10);
      const server = app.getHttpServer();
      const current = (await request(server).get(`/v1/inventory/stock/${v}/${warehouseId}`).set('Authorization', auth).expect(200)).body;

      const updated = await request(server)
        .patch(`/v1/inventory/stock/${v}/${warehouseId}`)
        .set('Authorization', auth)
        .send({ version: current.version, reorderPoint: 5, reorderQty: 24, binLocation: 'A-03-2' })
        .expect(200);
      expect(updated.body).toMatchObject({ reorderPoint: 5, reorderQty: 24, binLocation: 'A-03-2', version: current.version + 1 });

      // Segundo cliente con la versión vieja: conflicto, no pisa el cambio.
      const stale = await request(server)
        .patch(`/v1/inventory/stock/${v}/${warehouseId}`)
        .set('Authorization', auth)
        .send({ version: current.version, reorderPoint: 1 })
        .expect(409);
      expect(stale.body.error.code).toBe('STALE_VERSION');

      await request(server)
        .patch(`/v1/inventory/stock/${v}/${warehouseId}`)
        .set('Authorization', `Bearer ${tokenFor(t, ['inventory.read'])}`)
        .send({ version: updated.body.version, reorderPoint: 1 })
        .expect(403);
    });

    it('lista movimientos del tenant con paginación por cursor', async () => {
      const [v] = await createVariants(db, t.tenantId, 1);
      for (const delta of [5, 3, -1]) {
        await adjust({ variantId: v, warehouseId, type: 'adjustment', delta, reason: 'mov' }).expect(201);
      }
      const server = app.getHttpServer();
      const page1 = await request(server)
        .get(`/v1/inventory/stock/movements?variantId=${v}&limit=2`)
        .set('Authorization', auth)
        .expect(200);
      expect(page1.body.map((m: { quantity: number }) => m.quantity)).toEqual([-1, 3]);

      const page2 = await request(server)
        .get(`/v1/inventory/stock/movements?variantId=${v}&limit=2&beforeId=${page1.body[1].id}`)
        .set('Authorization', auth)
        .expect(200);
      expect(page2.body.map((m: { quantity: number }) => m.quantity)).toEqual([5]);

      const other = await createTenant(db);
      const foreign = await request(server)
        .get(`/v1/inventory/stock/movements?variantId=${v}`)
        .set('Authorization', `Bearer ${tokenFor(other)}`)
        .expect(200);
      expect(foreign.body).toEqual([]);
    });
  });
});
