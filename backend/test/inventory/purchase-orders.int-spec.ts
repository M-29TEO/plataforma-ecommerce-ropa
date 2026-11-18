import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Database } from '../../libs/shared-kernel';
import { createTenant, createVariants, createWarehouse, getStock, TestTenant, tokenFor } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

describe('Inventario · proveedores y órdenes de compra (HTTP)', () => {
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

  const post = (url: string, body: unknown = {}, token = auth) =>
    request(app.getHttpServer()).post(url).set('Authorization', token).send(body as object);

  const createSupplier = async (name = 'Textiles Andinos S.A.') =>
    (await post('/v1/inventory/suppliers', { name, ruc: '1790012345001', leadTimeDays: 10 }).expect(201)).body;

  describe('Proveedores', () => {
    it('CRUD con validación de RUC y búsqueda', async () => {
      const supplier = (
        await post('/v1/inventory/suppliers', {
          name: 'Confecciones del Pacífico',
          ruc: '0992345678001',
          contact: { name: 'Ana Pérez', email: 'compras@pacifico.test', phone: '0991234567' },
          leadTimeDays: 7,
        }).expect(201)
      ).body;
      expect(supplier).toMatchObject({ ruc: '0992345678001', leadTimeDays: 7, active: true });

      const bad = await post('/v1/inventory/suppliers', { name: 'X', ruc: '2590012345001' }).expect(422);
      expect(bad.body.error.code).toBe('INVALID_RUC');
      await post('/v1/inventory/suppliers', { name: 'X', contact: { email: 'no-es-email' } }).expect(400);

      const server = app.getHttpServer();
      const found = await request(server).get('/v1/inventory/suppliers?search=pacíf').set('Authorization', auth).expect(200);
      expect(found.body.map((s: { id: string }) => s.id)).toContain(supplier.id);

      const updated = await request(server)
        .patch(`/v1/inventory/suppliers/${supplier.id}`)
        .set('Authorization', auth)
        .send({ active: false, leadTimeDays: 15 })
        .expect(200);
      expect(updated.body).toMatchObject({ active: false, leadTimeDays: 15 });

      await post('/v1/inventory/suppliers', { name: 'Sin permiso' }, `Bearer ${tokenFor(t, ['inventory.read'])}`).expect(403);
    });
  });

  describe('Órdenes de compra', () => {
    it('flujo completo: crear → enviar → recepción parcial → recepción final', async () => {
      const supplier = await createSupplier();
      const [v1, v2] = await createVariants(db, t.tenantId, 2);
      const server = app.getHttpServer();

      const po = (
        await post('/v1/inventory/purchase-orders', {
          supplierId: supplier.id,
          warehouseId,
          expectedAt: '2026-10-15',
          items: [
            { variantId: v1, qtyOrdered: 10, unitCost: '8.35' },
            { variantId: v2, qtyOrdered: 5, unitCost: '12.00' },
          ],
        }).expect(201)
      ).body;
      expect(po).toMatchObject({ status: 'draft', total: '143.50', expectedAt: '2026-10-15', createdBy: t.userId });
      expect(po.number).toMatch(/^OC-\d{8}-[0-9A-F]{6}$/);
      const item1 = po.items.find((i: { variantId: string }) => i.variantId === v1);
      const item2 = po.items.find((i: { variantId: string }) => i.variantId === v2);

      // No se recibe mercadería de una orden que el proveedor aún no tiene.
      const early = await post(`/v1/inventory/purchase-orders/${po.id}/receipts`, { lines: [{ itemId: item1.id, quantity: 1 }] }).expect(409);
      expect(early.body.error.code).toBe('INVALID_PO_TRANSITION');

      expect((await post(`/v1/inventory/purchase-orders/${po.id}/send`).expect(200)).body.status).toBe('sent');

      const partial = await post(`/v1/inventory/purchase-orders/${po.id}/receipts`, {
        lines: [{ itemId: item1.id, quantity: 6 }],
        note: 'Primera entrega, guía 001-123',
      }).expect(200);
      expect(partial.body.status).toBe('partially_received');
      expect(await getStock(db, v1, warehouseId)).toMatchObject({ on_hand: 6, available: 6 });

      const over = await post(`/v1/inventory/purchase-orders/${po.id}/receipts`, {
        lines: [{ itemId: item1.id, quantity: 5 }],
      }).expect(422);
      expect(over.body.error.code).toBe('OVER_RECEIPT');
      expect(over.body.error.details).toMatchObject({ pending: 4, requested: 5 });

      const final = await post(`/v1/inventory/purchase-orders/${po.id}/receipts`, {
        lines: [
          { itemId: item1.id, quantity: 4 },
          { itemId: item2.id, quantity: 5 },
        ],
      }).expect(200);
      expect(final.body.status).toBe('received');
      expect(await getStock(db, v1, warehouseId)).toMatchObject({ on_hand: 10 });
      expect(await getStock(db, v2, warehouseId)).toMatchObject({ on_hand: 5 });

      const { rows } = await db.query(
        `SELECT variant_id, quantity, movement_type, unit_cost, reference_type, reference_id, reason, user_id
           FROM inventory.stock_movements WHERE reference_id = $1 ORDER BY id`,
        [po.id],
      );
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        variant_id: v1,
        quantity: 6,
        movement_type: 'purchase',
        unit_cost: '8.35',
        reference_type: 'purchase_order',
        reason: 'Primera entrega, guía 001-123',
        user_id: t.userId,
      });

      const stored = await request(server).get(`/v1/inventory/purchase-orders/${po.id}`).set('Authorization', auth).expect(200);
      expect(stored.body.items.map((i: { qtyReceived: number }) => i.qtyReceived).sort()).toEqual([10, 5].sort());
      await post(`/v1/inventory/purchase-orders/${po.id}/cancel`).expect(409);
    });

    it('dos recepciones simultáneas de lo mismo: solo una entra (FOR UPDATE + CHECK)', async () => {
      const supplier = await createSupplier();
      const [v] = await createVariants(db, t.tenantId, 1);
      const po = (
        await post('/v1/inventory/purchase-orders', {
          supplierId: supplier.id,
          warehouseId,
          items: [{ variantId: v, qtyOrdered: 4, unitCost: '5.00' }],
        }).expect(201)
      ).body;
      await post(`/v1/inventory/purchase-orders/${po.id}/send`).expect(200);

      const body = { lines: [{ itemId: po.items[0].id, quantity: 3 }] };
      const [a, b] = await Promise.all([
        post(`/v1/inventory/purchase-orders/${po.id}/receipts`, body),
        post(`/v1/inventory/purchase-orders/${po.id}/receipts`, body),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 422]);
      expect(await getStock(db, v, warehouseId)).toMatchObject({ on_hand: 3 });
    });

    it('el CHECK de la base de datos impide qty_received > qty_ordered aunque se salte el dominio', async () => {
      const supplier = await createSupplier();
      const [v] = await createVariants(db, t.tenantId, 1);
      const po = (
        await post('/v1/inventory/purchase-orders', {
          supplierId: supplier.id,
          warehouseId,
          items: [{ variantId: v, qtyOrdered: 2, unitCost: '1.00' }],
        }).expect(201)
      ).body;
      await expect(
        db.query('UPDATE inventory.purchase_order_items SET qty_received = 3 WHERE id = $1', [po.items[0].id]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'ck_poi_received_le_ordered' });
    });

    it('valida proveedor, bodega, permisos y número duplicado; permite cancelar y filtrar', async () => {
      const supplier = await createSupplier();
      const [v] = await createVariants(db, t.tenantId, 1);
      const items = [{ variantId: v, qtyOrdered: 1, unitCost: '1.00' }];
      const server = app.getHttpServer();

      const inactiveSupplier = await createSupplier('Inactivo');
      await request(server)
        .patch(`/v1/inventory/suppliers/${inactiveSupplier.id}`)
        .set('Authorization', auth)
        .send({ active: false })
        .expect(200);
      await post('/v1/inventory/purchase-orders', { supplierId: inactiveSupplier.id, warehouseId, items }).expect(404);

      const inactiveWh = await createWarehouse(db, t.tenantId, { active: false });
      await post('/v1/inventory/purchase-orders', { supplierId: supplier.id, warehouseId: inactiveWh, items }).expect(409);

      await post('/v1/inventory/purchase-orders', { supplierId: supplier.id, warehouseId, items: [] }).expect(400);
      await post('/v1/inventory/purchase-orders', { supplierId: supplier.id, warehouseId, items: [{ ...items[0], qtyOrdered: 100_001 }] }).expect(400);
      const other = await createTenant(db);
      const [foreign] = await createVariants(db, other.tenantId, 1);
      const foreignPo = await post('/v1/inventory/purchase-orders', { supplierId: supplier.id, warehouseId, items: [{ ...items[0], variantId: foreign }] }).expect(404);
      expect(foreignPo.body.error.code).toBe('VARIANT_NOT_FOUND');
      await post('/v1/inventory/purchase-orders', { supplierId: supplier.id, warehouseId, items: [{ ...items[0], unitCost: '1.999' }] }).expect(400);

      const po = (await post('/v1/inventory/purchase-orders', { supplierId: supplier.id, warehouseId, number: 'OC-MANUAL-1', items }).expect(201)).body;
      const dup = await post('/v1/inventory/purchase-orders', { supplierId: supplier.id, warehouseId, number: 'OC-MANUAL-1', items }).expect(409);
      expect(dup.body.error.code).toBe('PO_NUMBER_TAKEN');

      // Recibir exige un permiso distinto al de crear.
      await post(`/v1/inventory/purchase-orders/${po.id}/send`).expect(200);
      await post(
        `/v1/inventory/purchase-orders/${po.id}/receipts`,
        { lines: [{ itemId: po.items[0].id, quantity: 1 }] },
        `Bearer ${tokenFor(t, ['inventory.read', 'inventory.purchase.write'])}`,
      ).expect(403);

      expect((await post(`/v1/inventory/purchase-orders/${po.id}/cancel`).expect(200)).body.status).toBe('cancelled');
      const cancelled = await request(server)
        .get(`/v1/inventory/purchase-orders?status=cancelled&supplierId=${supplier.id}`)
        .set('Authorization', auth)
        .expect(200);
      expect(cancelled.body.map((o: { id: string }) => o.id)).toEqual([po.id]);
    });
  });
});
