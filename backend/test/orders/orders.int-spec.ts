import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { NewOrder, OrdersApi } from '../../libs/modules/orders';
import { Database, signAccessToken } from '../../libs/shared-kernel';
import {
  createCustomer,
  createTenant,
  createVariants,
  createWarehouse,
  customerTokenFor,
  ORDER_PERMISSIONS,
  TestTenant,
  tokenFor,
} from '../support/fixtures';
import { createTestApp } from '../support/test-app';

describe('Pedidos (HTTP + PostgreSQL)', () => {
  let app: INestApplication;
  let db: Database;
  let orders: OrdersApi;
  let t: TestTenant;
  let staff: string;
  let warehouseId: string;
  let variants: string[];
  let customerA: string;
  let customerB: string;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    orders = app.get(OrdersApi);
    t = await createTenant(db);
    staff = `Bearer ${tokenFor(t, ORDER_PERMISSIONS)}`;
    warehouseId = await createWarehouse(db, t.tenantId);
    variants = await createVariants(db, t.tenantId, 2);
    customerA = await createCustomer(db, t.tenantId);
    customerB = await createCustomer(db, t.tenantId);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const asCustomer = (id: string) => `Bearer ${customerTokenFor(t.tenantId, id)}`;

  function orderInput(overrides: Partial<NewOrder> = {}): NewOrder {
    return {
      id: randomUUID(),
      tenantId: t.tenantId,
      userId: customerA,
      customer: { name: 'María Loor', email: 'maria.loor@example.test' },
      billing: { idType: '05', idNumber: '1712345678' },
      paymentMethod: 'card',
      fulfillmentType: 'rider',
      shippingAddress: { mainStreet: 'Av. Amazonas', city: 'Quito' },
      shippingLocation: { lat: -0.1807, lng: -78.4678 },
      shippingCity: 'Quito',
      sourceWarehouseId: warehouseId,
      shippingTotal: '3.50',
      items: [
        {
          variantId: variants[0],
          productId: randomUUID(),
          sku: 'CAM-NEG-M',
          productName: 'Camiseta básica',
          brandName: 'Andina',
          categoryPath: 'unisex/camisetas',
          colorName: 'Negro',
          sizeCode: 'M',
          quantity: 2,
          unitPrice: '14.90',
          discount: '2.00',
          taxCode: '4',
          taxRate: '15.00',
          unitCost: '6.10',
          warehouseId,
        },
        {
          variantId: variants[1],
          productId: randomUUID(),
          sku: 'JEAN-AZ-32',
          productName: 'Jean slim',
          colorName: 'Azul',
          sizeCode: '32',
          quantity: 1,
          unitPrice: '39.99',
          taxCode: '4',
          taxRate: '15.00',
          warehouseId,
        },
      ],
      ...overrides,
    };
  }

  const place = (overrides: Partial<NewOrder> = {}) => orders.placeOrder(orderInput(overrides));

  const changeStatus = (id: string, body: object, token = staff) =>
    request(server()).post(`/v1/orders/${id}/status`).set('Authorization', token).send(body);

  /** Avanza por la API con la versión que devuelve cada paso (como haría el backoffice). */
  async function advance(id: string, path: string[], token = staff) {
    let version = (await request(server()).get(`/v1/orders/${id}`).set('Authorization', staff).expect(200)).body.version;
    let body: any;
    for (const to of path) {
      body = (await changeStatus(id, { to, version, reason: 'motivo de prueba' }, token).expect(200)).body;
      version = body.version;
    }
    return body;
  }

  async function events(orderId: string) {
    const { rows } = await db.query<{ event_type: string; payload: any; aggregate_type: string }>(
      `SELECT event_type, payload, aggregate_type FROM platform.outbox_events WHERE aggregate_id = $1 ORDER BY id`,
      [orderId],
    );
    return rows;
  }

  async function history(orderId: string) {
    const { rows } = await db.query<{ from_status: string | null; to_status: string; actor_type: string; actor_id: string | null; reason: string | null }>(
      `SELECT from_status, to_status, actor_type, actor_id, reason FROM sales.order_status_history WHERE order_id = $1 ORDER BY id`,
      [orderId],
    );
    return rows;
  }

  describe('creación (OrdersApi.placeOrder)', () => {
    it('persiste snapshots, totales, historial null → created y OrderPlaced en la misma transacción', async () => {
      const o = await place();
      expect(o.orderNumber).toMatch(/^\d+$/);
      expect(o).toMatchObject({ status: 'created', paymentStatus: 'pending', version: 0, total: '81.46' });

      const { rows: items } = await db.query(
        `SELECT sku, product_name, brand_name, category_path, color_name, size_code, quantity, unit_price, discount,
                tax_rate, tax_amount, line_total, unit_cost
           FROM sales.order_items WHERE order_id = $1 ORDER BY sku`,
        [o.id],
      );
      expect(items).toEqual([
        {
          sku: 'CAM-NEG-M', product_name: 'Camiseta básica', brand_name: 'Andina', category_path: 'unisex/camisetas',
          color_name: 'Negro', size_code: 'M', quantity: 2, unit_price: '14.90', discount: '2.00', tax_rate: '15.00',
          tax_amount: '4.17', line_total: '31.97', unit_cost: '6.10',
        },
        {
          sku: 'JEAN-AZ-32', product_name: 'Jean slim', brand_name: null, category_path: null, color_name: 'Azul',
          size_code: '32', quantity: 1, unit_price: '39.99', discount: '0.00', tax_rate: '15.00', tax_amount: '6.00',
          line_total: '45.99', unit_cost: null,
        },
      ]);

      // El snapshot no depende del catálogo: cambiar la variante no altera el pedido.
      await db.query(`UPDATE catalog.product_variants SET sku = sku || '-X' WHERE id = $1`, [variants[1]]);
      const detail = await orders.getOrder(t.tenantId, o.id);
      expect(detail.items.map((i) => i.sku).sort()).toEqual(['CAM-NEG-M', 'JEAN-AZ-32']);
      expect(detail.shippingLocation).toEqual({ lat: -0.1807, lng: -78.4678 });

      expect(await history(o.id)).toEqual([
        { from_status: null, to_status: 'created', actor_type: 'system', actor_id: null, reason: null },
      ]);
      const evs = await events(o.id);
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({
        event_type: 'OrderPlaced',
        aggregate_type: 'sales.order',
        payload: { orderId: o.id, orderNumber: o.orderNumber, paymentMethod: 'card', total: '81.46' },
      });
      expect(evs[0].payload.items).toHaveLength(2);
    });

    it('es idempotente por id: un reintento de Checkout no duplica pedido, historial ni eventos', async () => {
      const input = orderInput();
      const first = await orders.placeOrder(input);
      const again = await orders.placeOrder(input);
      expect(again.orderNumber).toBe(first.orderNumber);
      expect(await history(first.id)).toHaveLength(1);
      expect(await events(first.id)).toHaveLength(1);
    });

    it('rechaza montos inválidos sin escribir nada', async () => {
      const input = orderInput({ giftCardTotal: '500' });
      await expect(orders.placeOrder(input)).rejects.toMatchObject({ code: 'GIFT_CARD_EXCEEDS_TOTAL' });
      const { rowCount } = await db.query('SELECT 1 FROM sales.orders WHERE id = $1', [input.id]);
      expect(rowCount).toBe(0);
    });
  });

  describe('flujos completos', () => {
    it('pagado: created → paid → preparing → shipped → in_transit → delivered', async () => {
      const o = await place();
      const final = await advance(o.id, ['paid', 'preparing', 'shipped', 'in_transit', 'delivered']);
      expect(final).toMatchObject({ status: 'delivered', paymentStatus: 'paid', version: 5 });
      expect(final.paidAt && final.shippedAt && final.deliveredAt).toBeTruthy();

      expect((await history(o.id)).map((h) => `${h.from_status}->${h.to_status}`)).toEqual([
        'null->created',
        'created->paid',
        'paid->preparing',
        'preparing->shipped',
        'shipped->in_transit',
        'in_transit->delivered',
      ]);
      expect((await history(o.id)).slice(1).every((h) => h.actor_type === 'staff' && h.actor_id === t.userId)).toBe(true);
      expect((await events(o.id)).map((e) => e.event_type)).toEqual(['OrderPlaced', 'OrderPaid', 'OrderDelivered']);

      const h = await request(server()).get(`/v1/orders/${o.id}/history`).set('Authorization', staff).expect(200);
      expect(h.body).toHaveLength(6);
    });

    it('contra entrega: created → preparing sin pago; al entregar se cobra (OrderPaid + OrderDelivered)', async () => {
      const o = await place({ paymentMethod: 'cod' });
      expect(o.paymentStatus).toBe('cod_pending');

      const rejected = await changeStatus(o.id, { to: 'paid', version: 0 }).expect(409);
      expect(rejected.body.error.code).toBe('INVALID_ORDER_TRANSITION');

      const preparing = await advance(o.id, ['preparing']);
      expect(preparing).toMatchObject({ status: 'preparing', paymentStatus: 'cod_pending', paidAt: null });

      const final = await advance(o.id, ['shipped', 'in_transit', 'delivered']);
      expect(final).toMatchObject({ status: 'delivered', paymentStatus: 'paid' });
      expect((await events(o.id)).map((e) => e.event_type)).toEqual(['OrderPlaced', 'OrderPaid', 'OrderDelivered']);
    });

    it('retiro en tienda: preparing → delivered sin despacho', async () => {
      const o = await place({ fulfillmentType: 'pickup', shippingAddress: null, shippingLocation: null });
      await advance(o.id, ['paid', 'preparing']);
      const res = await changeStatus(o.id, { to: 'shipped', version: 2 }).expect(409);
      expect(res.body.error.code).toBe('INVALID_ORDER_TRANSITION');
      expect(await advance(o.id, ['delivered'])).toMatchObject({ status: 'delivered', shippedAt: null });
    });

    it('la cancelación guarda el motivo y emite OrderCancelled', async () => {
      const o = await place();
      const cancelled = (await changeStatus(o.id, { to: 'cancelled', version: 0, reason: 'Sin stock físico' }).expect(200)).body;
      expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Sin stock físico' });
      const ev = (await events(o.id)).find((e) => e.event_type === 'OrderCancelled');
      expect(ev?.payload).toMatchObject({ previousStatus: 'created', reason: 'Sin stock físico', cancelledBy: 'staff' });
    });

    it('la devolución no se fija a mano: la registra el flujo de devoluciones (test/aftersales)', async () => {
      const d = await place();
      const delivered = await advance(d.id, ['paid', 'preparing', 'shipped', 'in_transit', 'delivered']);
      await changeStatus(d.id, { to: 'returned', version: delivered.version, reason: 'Devolución total' }).expect(400);
      expect((await history(d.id)).at(-1)).toMatchObject({ to_status: 'delivered' });
    });
  });

  describe('transiciones inválidas', () => {
    it('responde 409 y no cambia versión, historial ni outbox', async () => {
      const o = await place();
      const res = await changeStatus(o.id, { to: 'shipped', version: 0 }).expect(409);
      expect(res.body.error).toMatchObject({ code: 'INVALID_ORDER_TRANSITION', details: { from: 'created', to: 'shipped' } });

      const after = await orders.getOrder(t.tenantId, o.id);
      expect(after).toMatchObject({ status: 'created', version: 0 });
      expect(await history(o.id)).toHaveLength(1);
      expect(await events(o.id)).toHaveLength(1);
    });

    it('estado final: un pedido cancelado no vuelve a moverse', async () => {
      const o = await place();
      await changeStatus(o.id, { to: 'cancelled', version: 0, reason: 'Duplicado' }).expect(200);
      for (const to of ['created', 'paid', 'preparing', 'cancelled']) {
        const res = await changeStatus(o.id, { to, version: 1, reason: 'x' }).expect(409);
        expect(res.body.error.code).toBe('INVALID_ORDER_TRANSITION');
      }
    });

    it('cancelar sin motivo → 422; estado desconocido → 400', async () => {
      const o = await place();
      expect((await changeStatus(o.id, { to: 'cancelled', version: 0 }).expect(422)).body.error.code).toBe('REASON_REQUIRED');
      await changeStatus(o.id, { to: 'partially_returned', version: 0 }).expect(400);
      await changeStatus(o.id, { to: 'paid' }).expect(400); // falta version
    });

    it('pedido inexistente o de otro tenant → 404', async () => {
      await changeStatus(randomUUID(), { to: 'paid', version: 0 }).expect(404);
      const other = await createTenant(db);
      const o = await place();
      await request(server())
        .get(`/v1/orders/${o.id}`)
        .set('Authorization', `Bearer ${tokenFor(other, ORDER_PERMISSIONS)}`)
        .expect(404);
    });
  });

  describe('concurrencia optimista (version)', () => {
    it('una versión desactualizada responde 409 STALE_VERSION', async () => {
      const o = await place();
      await changeStatus(o.id, { to: 'paid', version: 0 }).expect(200);
      const res = await changeStatus(o.id, { to: 'preparing', version: 0 }).expect(409);
      expect(res.body.error).toMatchObject({ code: 'STALE_VERSION', details: { expectedVersion: 0, currentVersion: 1 } });
    });

    it('dos cambios simultáneos con la misma versión: gana uno solo', async () => {
      const o = await place();
      const results = await Promise.all([
        changeStatus(o.id, { to: 'paid', version: 0 }),
        changeStatus(o.id, { to: 'cancelled', version: 0, reason: 'Cliente desiste' }),
        changeStatus(o.id, { to: 'paid', version: 0 }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409]);
      expect(results.filter((r) => r.status === 409).every((r) => ['STALE_VERSION', 'INVALID_ORDER_TRANSITION'].includes(r.body.error.code))).toBe(true);
      expect(await history(o.id)).toHaveLength(2);
      expect((await orders.getOrder(t.tenantId, o.id)).version).toBe(1);
    });

    it('markPaid (consumidor de PaymentCaptured) es idempotente incluso en paralelo', async () => {
      const o = await place();
      const results = await Promise.all([orders.markPaid(t.tenantId, o.id), orders.markPaid(t.tenantId, o.id), orders.markPaid(t.tenantId, o.id)]);
      expect(results.every((r) => r.status === 'paid')).toBe(true);
      expect((await events(o.id)).filter((e) => e.event_type === 'OrderPaid')).toHaveLength(1);
      expect(await history(o.id)).toHaveLength(2);
    });
  });

  describe('permisos', () => {
    it('cada estado destino exige su permiso', async () => {
      const o = await place();
      const onlyUpdate = `Bearer ${tokenFor(t, ['orders.read', 'orders.status.update'])}`;
      await changeStatus(o.id, { to: 'paid', version: 0 }, onlyUpdate).expect(403);
      await changeStatus(o.id, { to: 'cancelled', version: 0, reason: 'x' }, onlyUpdate).expect(403);
      await changeStatus(o.id, { to: 'paid', version: 0 }, `Bearer ${tokenFor(t, ['orders.payment.confirm'])}`).expect(200);
      await changeStatus(o.id, { to: 'preparing', version: 1 }, onlyUpdate).expect(200);
    });

    it('sin orders.read no se lista; sin token 401; un cliente no usa los endpoints de staff', async () => {
      await request(server()).get('/v1/orders').set('Authorization', `Bearer ${tokenFor(t, ['inventory.read'])}`).expect(403);
      await request(server()).get('/v1/orders').expect(401);
      const o = await place();
      await request(server()).get('/v1/orders').set('Authorization', asCustomer(customerA)).expect(403);
      await changeStatus(o.id, { to: 'paid', version: 0 }, asCustomer(customerA)).expect(403);
    });

    it('un motorizado solo marca en camino o entregado, aunque su rol tenga más permisos', async () => {
      const perms = ['orders.read', 'orders.status.update', 'orders.cancel', 'orders.payment.confirm'];
      const rider = `Bearer ${signAccessToken({ id: randomUUID(), tenantId: t.tenantId, type: 'rider', permissions: perms }, process.env.JWT_SECRET!)}`;
      const o = await place();
      await changeStatus(o.id, { to: 'paid', version: 0 }, rider).expect(403);
      await changeStatus(o.id, { to: 'cancelled', version: 0, reason: 'no quiero' }, rider).expect(403);
      const shipped = await advance(o.id, ['paid', 'preparing', 'shipped']);
      await changeStatus(o.id, { to: 'in_transit', version: shipped.version }, rider).expect(200);
      await changeStatus(o.id, { to: 'delivered', version: shipped.version + 1 }, rider).expect(200);
    });
  });

  describe('cliente: /v1/me/orders', () => {
    it('lista y ve solo sus pedidos; uno ajeno es 404', async () => {
      const mine = await place({ userId: customerB });
      const other = await place({ userId: customerA });

      const list = await request(server()).get('/v1/me/orders').set('Authorization', asCustomer(customerB)).expect(200);
      const ids = list.body.map((o: { id: string }) => o.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(other.id);
      expect(list.body.every((o: { userId: string }) => o.userId === customerB)).toBe(true);
      expect(list.body[0].itemCount).toBe(2);

      const detail = await request(server()).get(`/v1/me/orders/${mine.id}`).set('Authorization', asCustomer(customerB)).expect(200);
      expect(detail.body.items).toHaveLength(2);
      expect(detail.body.history).toHaveLength(1);
      await request(server()).get(`/v1/me/orders/${other.id}`).set('Authorization', asCustomer(customerB)).expect(404);
      await request(server()).get('/v1/me/orders').set('Authorization', staff).expect(403);
    });

    it('cancela su pedido antes de preparación; después ya no puede', async () => {
      const o = await place({ userId: customerB });
      const cancel = (id: string, version: number, user = customerB) =>
        request(server()).post(`/v1/me/orders/${id}/cancel`).set('Authorization', asCustomer(user)).send({ version, reason: 'Ya no lo necesito' });

      await cancel(o.id, 0, customerA).expect(404);
      const res = await cancel(o.id, 0).expect(200);
      expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'Ya no lo necesito' });
      expect((await history(o.id)).at(-1)).toMatchObject({ actor_type: 'customer', actor_id: customerB });

      const p = await place({ userId: customerB });
      await advance(p.id, ['paid', 'preparing']);
      const late = await cancel(p.id, 2).expect(409);
      expect(late.body.error.code).toBe('CUSTOMER_TRANSITION_NOT_ALLOWED');
    });

    it('filtra por estado', async () => {
      const customer = await createCustomer(db, t.tenantId);
      const a = await place({ userId: customer });
      const b = await place({ userId: customer });
      await orders.markPaid(t.tenantId, b.id);
      const res = await request(server()).get('/v1/me/orders?status=paid').set('Authorization', asCustomer(customer)).expect(200);
      expect(res.body.map((o: { id: string }) => o.id)).toEqual([b.id]);
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('staff: listar y filtrar', () => {
    let tenant: TestTenant;
    let token: string;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      tenant = await createTenant(db);
      token = `Bearer ${tokenFor(tenant, ORDER_PERMISSIONS)}`;
      const wh = await createWarehouse(db, tenant.tenantId);
      const [v] = await createVariants(db, tenant.tenantId, 1);
      const base = orderInput();
      const line = { ...base.items[0], variantId: v, warehouseId: wh };
      const mk = (overrides: Partial<NewOrder>) =>
        orders.placeOrder({ ...base, id: randomUUID(), tenantId: tenant.tenantId, userId: null, sourceWarehouseId: wh, items: [line], ...overrides });

      ids.card = (await mk({ customer: { name: 'Ana', email: 'ana.torres@example.test' } })).id;
      ids.cod = (await mk({ paymentMethod: 'cod', customer: { name: 'Luis', email: 'luis@example.test' } })).id;
      ids.pickup = (await mk({ fulfillmentType: 'pickup', shippingAddress: null, channel: 'store', customer: { name: 'Eva', email: 'eva@example.test' } })).id;
      await orders.markPaid(tenant.tenantId, ids.card);
    });

    const list = (qs: string) =>
      request(server()).get(`/v1/orders${qs}`).set('Authorization', token).expect(200).then((r) => r.body.map((o: { id: string }) => o.id).sort());

    it('sin filtros devuelve todos los del tenant, del más reciente al más antiguo', async () => {
      const res = await request(server()).get('/v1/orders').set('Authorization', token).expect(200);
      expect(res.body.map((o: { id: string }) => o.id)).toEqual([ids.pickup, ids.cod, ids.card]);
    });

    it('filtra por estado (uno o varios), pago, entrega y canal', async () => {
      expect(await list('?status=paid')).toEqual([ids.card]);
      expect(await list('?status=paid,created')).toEqual([ids.card, ids.cod, ids.pickup].sort());
      expect(await list('?status=created&status=paid')).toEqual([ids.card, ids.cod, ids.pickup].sort());
      expect(await list('?paymentMethod=cod')).toEqual([ids.cod]);
      expect(await list('?paymentStatus=cod_pending')).toEqual([ids.cod]);
      expect(await list('?fulfillmentType=pickup')).toEqual([ids.pickup]);
      expect(await list('?channel=store')).toEqual([ids.pickup]);
    });

    it('busca por número de pedido o email, y por rango de fechas', async () => {
      const card = await orders.getOrder(tenant.tenantId, ids.card);
      expect(await list(`?q=${card.orderNumber}`)).toEqual([ids.card]);
      expect(await list('?q=ANA.TOR')).toEqual([ids.card]);
      expect(await list('?q=100%25')).toEqual([]); // % se escapa, no es comodín
      expect(await list('?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z')).toEqual([]);
      expect((await list(`?from=${new Date(Date.now() - 3_600_000).toISOString()}`)).length).toBe(3);
    });

    it('valida la query y pagina', async () => {
      await request(server()).get('/v1/orders?status=enviado').set('Authorization', token).expect(400);
      await request(server()).get('/v1/orders?limit=500').set('Authorization', token).expect(400);
      await request(server()).get('/v1/orders?offset=10001').set('Authorization', token).expect(400);
      // Rango de fechas invertido o de más de 366 días: 400.
      await request(server()).get('/v1/orders?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z').set('Authorization', token).expect(400);
      await request(server()).get('/v1/orders?from=2024-01-01T00:00:00Z&to=2025-06-01T00:00:00Z').set('Authorization', token).expect(400);
      const page = await request(server()).get('/v1/orders?limit=2&offset=2').set('Authorization', token).expect(200);
      expect(page.body.map((o: { id: string }) => o.id)).toEqual([ids.card]);
    });
  });
});
