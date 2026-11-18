import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { findSystemRole } from '../../libs/modules/iam/domain/system-roles';
import { NewOrder, OrdersApi } from '../../libs/modules/orders';
import { Database, signAccessToken } from '../../libs/shared-kernel';
import { createCustomer, createSellableVariant, createTenant, createWarehouse, outboxEvents, TestTenant } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

const DEST = { lat: -0.1765, lng: -78.4844 };

/**
 * Picking de bodega (orquestador fulfillment): cola, detalle con códigos de barras, inicio
 * idempotente (pedido → preparing) y cierre con validación de cantidades (envío → ready_for_pickup).
 */
describe('Picking de bodega (integración)', () => {
  let app: INestApplication;
  let db: Database;
  let orders: OrdersApi;
  let t: TestTenant;
  let warehouseId: string;
  let otherWarehouseId: string;
  let customerId: string;
  let shirt: { productId: string; variantId: string };
  let jeans: { productId: string; variantId: string };

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    orders = app.get(OrdersApi);
    t = await createTenant(db);
    warehouseId = await createWarehouse(db, t.tenantId);
    otherWarehouseId = await createWarehouse(db, t.tenantId);
    customerId = await createCustomer(db, t.tenantId);
    shirt = await createSellableVariant(db, t.tenantId, { price: '20.00', name: 'Camiseta' });
    jeans = await createSellableVariant(db, t.tenantId, { price: '40.00', name: 'Jean' });
    await db.query(`UPDATE catalog.product_variants SET barcode = $2 WHERE id = $1`, [shirt.variantId, `786${randomUUID().replace(/\D/g, '').slice(0, 10)}`]);
    await db.query(
      `INSERT INTO catalog.product_media (product_id, media_type, storage_key, sort_order) VALUES ($1, 'image', 'products/camiseta-1.jpg', 0)`,
      [shirt.productId],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const bearer = (tenantId: string, permissions: readonly string[], type: 'staff' | 'customer' = 'staff') =>
    `Bearer ${signAccessToken({ id: t.userId, tenantId, type, permissions: [...permissions] }, process.env.JWT_SECRET!)}`;
  const warehouseStaff = () => bearer(t.tenantId, findSystemRole('warehouse')!.permissions);
  const seller = () => bearer(t.tenantId, findSystemRole('seller')!.permissions);

  /** Pedido como lo deja el checkout: con envío 'pending' salvo retiro en tienda. */
  async function placeOrder(opts: { method?: 'card' | 'cod'; paid?: boolean; type?: 'rider' | 'pickup'; warehouse?: string } = {}) {
    const type = opts.type ?? 'rider';
    const wh = opts.warehouse ?? warehouseId;
    const input: NewOrder = {
      id: randomUUID(),
      tenantId: t.tenantId,
      userId: customerId,
      customer: { name: 'Lucía Torres', email: 'lucia@example.test' },
      billing: {},
      paymentMethod: opts.method ?? 'card',
      fulfillmentType: type,
      shippingAddress: type === 'pickup' ? null : { mainStreet: 'Av. Amazonas', city: 'Quito' },
      shippingLocation: type === 'pickup' ? null : DEST,
      shippingCity: type === 'pickup' ? null : 'Quito',
      sourceWarehouseId: wh,
      notes: 'Envolver para regalo',
      items: [
        { ...shirt, sku: `SKU-C-${randomUUID().slice(0, 6)}`, productName: 'Camiseta', colorName: 'Negro', sizeCode: 'M', quantity: 2, unitPrice: '20.00', taxCode: '4', taxRate: '15.00', warehouseId: wh },
        { ...jeans, sku: `SKU-J-${randomUUID().slice(0, 6)}`, productName: 'Jean', quantity: 1, unitPrice: '40.00', taxCode: '4', taxRate: '15.00', warehouseId: wh },
      ],
    };
    const o = await orders.placeOrder(input);
    if (opts.paid ?? opts.method !== 'cod') await orders.markPaid(t.tenantId, o.id);
    let shipmentId: string | null = null;
    if (type !== 'pickup') {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO logistics.shipments (tenant_id, order_id, carrier_type, tracking_token, status, origin_warehouse_id, destination,
                                          destination_location, weight_g)
         VALUES ($1, $2, 'rider', $3, 'pending', $4, '{}'::jsonb, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, 800) RETURNING id`,
        [t.tenantId, o.id, randomBytes(18).toString('base64url'), wh, DEST.lng, DEST.lat],
      );
      shipmentId = rows[0].id;
    }
    const detail = await orders.getOrder(t.tenantId, o.id);
    return { orderId: o.id, shipmentId, version: detail.version, items: detail.items };
  }

  const queue = async (state: 'to_pick' | 'picking', wh = warehouseId) =>
    (await request(server()).get(`/v1/fulfillment/picking?warehouseId=${wh}&state=${state}`).set('Authorization', warehouseStaff()).expect(200)).body;
  const shipmentStatus = async (orderId: string) =>
    (await db.query<{ carrier_type: string; status: string; origin_warehouse_id: string }>(
      `SELECT carrier_type, status, origin_warehouse_id FROM logistics.shipments WHERE order_id = $1`,
      [orderId],
    )).rows;

  it('cola: pagados, contra entrega y retiro en tienda de la bodega; no los impagos ni los de otra bodega', async () => {
    const paid = await placeOrder();
    const cod = await placeOrder({ method: 'cod' });
    const pickup = await placeOrder({ type: 'pickup' });
    const unpaid = await placeOrder({ paid: false });
    const elsewhere = await placeOrder({ warehouse: otherWarehouseId });

    const body = await queue('to_pick');
    const ids = body.items.map((i: { orderId: string }) => i.orderId);
    expect(ids).toEqual(expect.arrayContaining([paid.orderId, cod.orderId, pickup.orderId]));
    expect(ids).not.toContain(unpaid.orderId);
    expect(ids).not.toContain(elsewhere.orderId);
    expect(body.total).toBe(ids.length);
    // Sin franjas: por antigüedad.
    expect(ids.indexOf(paid.orderId)).toBeLessThan(ids.indexOf(cod.orderId));
    expect(body.items.find((i: { orderId: string }) => i.orderId === cod.orderId)).toEqual({
      orderId: cod.orderId,
      orderNumber: expect.stringMatching(/^\d+$/),
      status: 'created',
      placedAt: expect.any(String),
      fulfillmentType: 'rider',
      paymentMethod: 'cod',
      warehouseId,
      deliverySlot: null,
      itemCount: 2,
      unitCount: 3,
      customerName: 'Lucía Torres',
    });

    // Paginación.
    const page = await request(server()).get(`/v1/fulfillment/picking?warehouseId=${warehouseId}&limit=1&offset=1`).set('Authorization', warehouseStaff()).expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0].orderId).toBe(ids[1]);
    expect(page.body.total).toBe(body.total);
  });

  it('detalle con sku, código de barras, imagen, color y talla de cada línea', async () => {
    const o = await placeOrder();
    const res = await request(server()).get(`/v1/fulfillment/picking/${o.orderId}`).set('Authorization', warehouseStaff()).expect(200);
    expect(res.body).toMatchObject({
      orderId: o.orderId,
      orderNumber: expect.stringMatching(/^\d+$/),
      status: 'paid',
      version: o.version,
      fulfillmentType: 'rider',
      warehouseId,
      notes: 'Envolver para regalo',
      shipmentStatus: 'pending',
    });
    const line = res.body.items.find((i: { variantId: string }) => i.variantId === shirt.variantId);
    expect(line).toEqual({
      orderItemId: expect.any(String),
      variantId: shirt.variantId,
      sku: expect.stringMatching(/^SKU-C-/),
      barcode: expect.stringMatching(/^786\d+$/),
      productName: 'Camiseta',
      color: 'Negro',
      size: 'M',
      quantity: 2,
      imageUrl: expect.stringMatching(/products\/camiseta-1\.jpg$/),
    });
    expect(res.body.items.find((i: { variantId: string }) => i.variantId === jeans.variantId)).toMatchObject({ barcode: null, imageUrl: null, quantity: 1 });
  });

  it('flujo completo: iniciar (idempotente, 409 con versión vieja), cierre incompleto o con sobrante 422, cierre OK → envío ready_for_pickup', async () => {
    const o = await placeOrder();
    const url = `/v1/fulfillment/picking/${o.orderId}`;

    await request(server()).post(`${url}/start`).set('Authorization', warehouseStaff()).send({ version: o.version + 5 }).expect(409);
    // Cerrar sin iniciar no se puede.
    const notStarted = await request(server()).post(`${url}/complete`).set('Authorization', warehouseStaff()).send({ items: [] }).expect(409);
    expect(notStarted.body.error.code).toBe('PICK_NOT_STARTED');

    const started = await request(server()).post(`${url}/start`).set('Authorization', warehouseStaff()).send({ version: o.version }).expect(200);
    expect(started.body).toEqual({ orderId: o.orderId, orderNumber: expect.any(String), status: 'preparing', version: o.version + 1, fulfillmentType: 'rider', warehouseId });
    const again = await request(server()).post(`${url}/start`).set('Authorization', warehouseStaff()).send({ version: o.version }).expect(200);
    expect(again.body).toEqual(started.body);

    expect((await queue('to_pick')).items.map((i: { orderId: string }) => i.orderId)).not.toContain(o.orderId);
    expect((await queue('picking')).items.map((i: { orderId: string }) => i.orderId)).toContain(o.orderId);

    const shirtLine = o.items.find((i) => i.variantId === shirt.variantId)!;
    const jeansLine = o.items.find((i) => i.variantId === jeans.variantId)!;

    const incomplete = await request(server())
      .post(`${url}/complete`)
      .set('Authorization', warehouseStaff())
      .send({ items: [{ orderItemId: shirtLine.id, pickedQuantity: 1 }] })
      .expect(422);
    expect(incomplete.body.error.code).toBe('PICK_INCOMPLETE');
    expect(incomplete.body.error.details.missing).toEqual(
      expect.arrayContaining([
        { orderItemId: shirtLine.id, expected: 2, picked: 1 },
        { orderItemId: jeansLine.id, expected: 1, picked: 0 },
      ]),
    );

    const excess = await request(server())
      .post(`${url}/complete`)
      .set('Authorization', warehouseStaff())
      .send({ items: [{ orderItemId: shirtLine.id, pickedQuantity: 3 }, { orderItemId: jeansLine.id, pickedQuantity: 1 }] })
      .expect(422);
    expect(excess.body.error.code).toBe('PICK_EXCESS');
    expect(excess.body.error.details.excess).toEqual([{ orderItemId: shirtLine.id, expected: 2, picked: 3 }]);
    expect(await shipmentStatus(o.orderId)).toEqual([expect.objectContaining({ status: 'pending' })]);

    const body = { items: [{ orderItemId: shirtLine.id, pickedQuantity: 2 }, { orderItemId: jeansLine.id, pickedQuantity: 1 }] };
    const done = await request(server()).post(`${url}/complete`).set('Authorization', warehouseStaff()).send(body).expect(200);
    expect(done.body).toEqual({
      orderId: o.orderId,
      orderNumber: expect.any(String),
      status: 'preparing',
      version: o.version + 1,
      fulfillmentType: 'rider',
      warehouseId,
      shipment: { id: o.shipmentId, carrierType: 'rider', status: 'ready_for_pickup' },
    });
    expect(await shipmentStatus(o.orderId)).toEqual([expect.objectContaining({ status: 'ready_for_pickup' })]);
    const events = await db.query<{ status: string; source: string }>(`SELECT status, source FROM logistics.shipment_events WHERE shipment_id = $1`, [o.shipmentId]);
    expect(events.rows).toEqual([{ status: 'ready_for_pickup', source: 'staff' }]);
    expect((await outboxEvents(db, t.tenantId, 'ShipmentStatusChanged')).filter((e) => e.aggregate_id === o.shipmentId)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ orderId: o.orderId, previousStatus: 'pending', status: 'ready_for_pickup' }) }),
    ]);

    // Auditado.
    const audit = await db.query<{ actor_id: string; outcome: string }>(
      `SELECT actor_id, after->>'outcome' AS outcome FROM platform.audit_log
        WHERE tenant_id = $1 AND action = 'fulfillment.picking.completed' AND entity_type = 'order' AND entity_id = $2 ORDER BY id`,
      [t.tenantId, o.orderId],
    );
    expect(audit.rows.map((r) => r.outcome)).toEqual(['failed', 'failed', 'failed', 'ok']);
    expect(audit.rows[3].actor_id).toBe(t.userId);

    // Ya no está en la mesa de picking; reintentar el cierre responde lo mismo sin otro evento.
    expect((await queue('picking')).items.map((i: { orderId: string }) => i.orderId)).not.toContain(o.orderId);
    const retry = await request(server()).post(`${url}/complete`).set('Authorization', warehouseStaff()).send(body).expect(200);
    expect(retry.body.shipment).toEqual(done.body.shipment);
    expect((await outboxEvents(db, t.tenantId, 'ShipmentStatusChanged')).filter((e) => e.aggregate_id === o.shipmentId)).toHaveLength(1);
  });

  it('contra entrega: created → preparing sin pago', async () => {
    const o = await placeOrder({ method: 'cod' });
    const res = await request(server()).post(`/v1/fulfillment/picking/${o.orderId}/start`).set('Authorization', warehouseStaff()).send({ version: o.version }).expect(200);
    expect(res.body.status).toBe('preparing');
  });

  it('retiro en tienda: al cerrar se crea el envío pickup ya listo para retirar en la tienda', async () => {
    const o = await placeOrder({ type: 'pickup', method: 'cod' });
    const url = `/v1/fulfillment/picking/${o.orderId}`;
    await request(server()).post(`${url}/start`).set('Authorization', warehouseStaff()).send({ version: o.version }).expect(200);
    const items = o.items.map((i) => ({ orderItemId: i.id, pickedQuantity: i.quantity }));
    const done = await request(server()).post(`${url}/complete`).set('Authorization', warehouseStaff()).send({ items }).expect(200);
    expect(done.body.shipment).toEqual({ id: expect.any(String), carrierType: 'pickup', status: 'ready_for_pickup' });
    expect(await shipmentStatus(o.orderId)).toEqual([{ carrier_type: 'pickup', status: 'ready_for_pickup', origin_warehouse_id: warehouseId }]);
    const cod = await db.query<{ cod_amount: string }>(`SELECT cod_amount FROM logistics.shipments WHERE order_id = $1`, [o.orderId]);
    expect(Number(cod.rows[0].cod_amount)).toBeGreaterThan(0);
    // Idempotente: no se crea un segundo envío.
    await request(server()).post(`${url}/complete`).set('Authorization', warehouseStaff()).send({ items }).expect(200);
    expect(await shipmentStatus(o.orderId)).toHaveLength(1);
  });

  it('sin el permiso inventory.picking (vendedor) o como cliente: 403', async () => {
    const o = await placeOrder();
    await request(server()).get('/v1/fulfillment/picking').set('Authorization', seller()).expect(403);
    await request(server()).get(`/v1/fulfillment/picking/${o.orderId}`).set('Authorization', seller()).expect(403);
    await request(server()).post(`/v1/fulfillment/picking/${o.orderId}/start`).set('Authorization', seller()).send({ version: o.version }).expect(403);
    await request(server()).post(`/v1/fulfillment/picking/${o.orderId}/complete`).set('Authorization', seller()).send({ items: [] }).expect(403);
    await request(server()).get('/v1/fulfillment/picking').set('Authorization', bearer(t.tenantId, ['inventory.picking'], 'customer')).expect(403);
    await request(server()).get('/v1/fulfillment/picking').expect(401);
  });

  it('pedido de otro tenant: 404 y no aparece en su cola', async () => {
    const o = await placeOrder();
    const other = await createTenant(db);
    const foreign = bearer(other.tenantId, ['inventory.picking']);
    await request(server()).get(`/v1/fulfillment/picking/${o.orderId}`).set('Authorization', foreign).expect(404);
    await request(server()).post(`/v1/fulfillment/picking/${o.orderId}/start`).set('Authorization', foreign).send({ version: o.version }).expect(404);
    await request(server()).post(`/v1/fulfillment/picking/${o.orderId}/complete`).set('Authorization', foreign).send({ items: [] }).expect(404);
    const q = await request(server()).get('/v1/fulfillment/picking').set('Authorization', foreign).expect(200);
    expect(q.body).toEqual({ items: [], total: 0 });
    expect((await orders.getOrder(t.tenantId, o.orderId)).status).toBe('paid');
  });

  it('valida el cuerpo y los parámetros', async () => {
    await request(server()).get('/v1/fulfillment/picking?state=shipped').set('Authorization', warehouseStaff()).expect(400);
    await request(server()).get('/v1/fulfillment/picking/no-es-uuid').set('Authorization', warehouseStaff()).expect(400);
    const o = await placeOrder();
    await request(server()).post(`/v1/fulfillment/picking/${o.orderId}/start`).set('Authorization', warehouseStaff()).send({}).expect(400);
    await request(server())
      .post(`/v1/fulfillment/picking/${o.orderId}/complete`)
      .set('Authorization', warehouseStaff())
      .send({ items: [{ orderItemId: 'x', pickedQuantity: -1 }] })
      .expect(400);
  });
});
