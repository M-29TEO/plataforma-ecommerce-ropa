import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { findSystemRole } from '../../libs/modules/iam/domain/system-roles';
import { Database } from '../../libs/shared-kernel';
import { customerTokenFor, getStock, outboxEvents, PROMOTION_PERMISSIONS, setStock, tokenFor } from '../support/fixtures';
import { ADDRESS, countRows, createShop, GUAYAQUIL, orderRow, paymentRow, reservations, Shop } from '../support/shop';
import { createTestApp } from '../support/test-app';

const SELLER = ['orders.assisted.create', 'orders.read'];

describe('Pedidos asistidos (HTTP + PostgreSQL)', () => {
  let app: INestApplication;
  let db: Database;
  let shop: Shop;
  let seller: string;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    shop = await createShop(db, { blusa: 10, bolso: 5 });
    seller = `Bearer ${tokenFor(shop, SELLER)}`;
    // Cliente registrado con nombre, teléfono, cédula y una dirección guardada con ubicación.
    await db.query(
      `UPDATE iam.users SET first_name = 'Ana', last_name = 'Pérez', phone = '0991234567', id_type = '05', id_number = '1710034065' WHERE id = $1`,
      [shop.customerId],
    );
    await request(server())
      .post('/v1/me/addresses')
      .set('Authorization', `Bearer ${customerTokenFor(shop.tenantId, shop.customerId)}`)
      .send({
        label: 'Casa',
        recipientName: 'Ana Pérez',
        recipientPhone: '0991234567',
        province: 'Pichincha',
        city: 'Quito',
        mainStreet: ADDRESS.mainStreet,
        pin: { lat: ADDRESS.lat, lng: ADDRESS.lng },
      })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const delivery = { type: 'rider', address: ADDRESS };

  function quote(body: Record<string, unknown>, auth = seller) {
    return request(server()).post('/v1/assisted-orders/quote').set('Authorization', auth).send(body);
  }

  function create(body: Record<string, unknown>, key: string | null = randomUUID(), auth = seller) {
    const req = request(server()).post('/v1/assisted-orders').set('Authorization', auth);
    if (key) req.set('Idempotency-Key', key);
    return req.send(body);
  }

  /** Cotiza y arma el cuerpo de creación con la primera opción (y franja) de envío. */
  async function orderBody(base: { items: unknown[]; customer: unknown; couponCode?: string }, extra: Record<string, unknown> = {}) {
    const q = await quote({ ...base, fulfillment: delivery }).expect(200);
    const option = q.body.delivery.options[0];
    return {
      ...base,
      fulfillment: { ...delivery, quoteToken: option.quoteId, ...(option.slots ? { slotId: option.slots[0].slotId } : {}) },
      paymentMethod: 'cod',
      ...extra,
    };
  }

  describe('búsqueda de clientes', () => {
    it.each([['email', () => 'cliente+'], ['nombre', () => 'ana pér'], ['teléfono', () => '099123'], ['cédula', () => '1710034065']])(
      'por %s, con sus direcciones y sin datos sensibles',
      async (_label, term) => {
        const res = await request(server()).get('/v1/assisted-orders/customers').query({ q: term() }).set('Authorization', seller).expect(200);
        const found = res.body.find((c: { userId: string }) => c.userId === shop.customerId);
        expect(found).toMatchObject({ firstName: 'Ana', lastName: 'Pérez', phone: '0991234567', idType: '05', idNumber: '1710034065' });
        expect(found.addresses).toEqual([expect.objectContaining({ label: 'Casa', city: 'Quito', isDefault: true, lat: ADDRESS.lat, lng: ADDRESS.lng })]);
        expect(found).not.toHaveProperty('passwordHash');
        expect(JSON.stringify(res.body)).not.toMatch(/password|mfa/i);
      },
    );

    it('no devuelve staff ni clientes de otro tenant; q de menos de 2 caracteres → 400', async () => {
      const other = await createShop(db);
      const res = await request(server()).get('/v1/assisted-orders/customers').query({ q: 'example.test' }).set('Authorization', seller).expect(200);
      const ids = res.body.map((c: { userId: string }) => c.userId);
      expect(ids).toEqual([shop.customerId]);
      expect(ids).not.toContain(other.customerId);
      await request(server()).get('/v1/assisted-orders/customers').query({ q: 'a' }).set('Authorization', seller).expect(400);
    });
  });

  describe('cotización', () => {
    it('totales y opciones de envío con token firmado y franjas, igual que el checkout web', async () => {
      const res = await quote({ items: [{ variantId: shop.blusa, quantity: 2 }], fulfillment: delivery }).expect(200);
      // 2 × 20.00 = 40.00 + IVA 6.00 + motorizado 3.00
      expect(res.body).toMatchObject({
        canPlace: true,
        issues: [],
        totals: { subtotal: '40.00', discountTotal: '0.00', shippingTotal: '3.00', taxTotal: '6.00', total: '49.00' },
        delivery: { fulfillmentType: 'rider', zone: { id: shop.zoneId } },
      });
      const [option] = res.body.delivery.options;
      expect(option).toMatchObject({ type: 'rider', price: '3.00', shippingTotal: '3.00', total: '49.00' });
      expect(option.quoteId.length).toBeGreaterThan(20);
      expect(option.slots[0]).toMatchObject({ slotId: shop.slotId, total: '49.00' });
      // Cotizar no reserva nada.
      expect(await getStock(db, shop.blusa, shop.warehouseId)).toMatchObject({ reserved: 0 });
    });

    it('fuera de zona: courier; retiro en tienda: sin envío', async () => {
      const courier = await quote({ items: [{ variantId: shop.bolso, quantity: 1 }], fulfillment: { type: 'courier', address: GUAYAQUIL } }).expect(200);
      expect(courier.body.delivery.fulfillmentType).toBe('courier');
      expect(courier.body.totals).toMatchObject({ shippingTotal: '5.50', total: '35.50' });

      const pickup = await quote({ items: [{ variantId: shop.bolso, quantity: 1 }], fulfillment: { type: 'pickup', pickupWarehouseId: shop.warehouseId } }).expect(200);
      expect(pickup.body).toMatchObject({ delivery: null, totals: { shippingTotal: '0.00', total: '30.00' } });
    });

    it('con la dirección guardada del cliente (addressId)', async () => {
      const found = await request(server()).get('/v1/assisted-orders/customers').query({ q: '1710034065' }).set('Authorization', seller).expect(200);
      const addressId = found.body[0].addresses[0].addressId;
      const res = await quote({
        customer: { userId: shop.customerId },
        items: [{ variantId: shop.blusa, quantity: 1 }],
        fulfillment: { type: 'rider', addressId },
      }).expect(200);
      expect(res.body.delivery.options[0].type).toBe('rider');
    });

    it('sin stock suficiente: canPlace false con el motivo por línea, sin opciones de envío', async () => {
      const res = await quote({ items: [{ variantId: shop.bolso, quantity: 9 }], fulfillment: delivery }).expect(200);
      expect(res.body.canPlace).toBe(false);
      expect(res.body.delivery).toBeNull();
      expect(res.body.issues).toEqual([{ variantId: shop.bolso, issues: [expect.objectContaining({ code: 'INSUFFICIENT_STOCK' })] }]);
    });

    it('cupón: aplicado en la cotización; uno inexistente se informa sin error', async () => {
      const staff = `Bearer ${tokenFor(shop, PROMOTION_PERMISSIONS)}`;
      const promo = await request(server())
        .post('/v1/promotions')
        .set('Authorization', staff)
        .send({ name: 'Diez', requiresCoupon: true, startsAt: '2026-01-01T00:00:00Z', type: 'percent', benefit: { percent: 10 } })
        .expect(201);
      await request(server()).post(`/v1/promotions/${promo.body.id}/coupons`).set('Authorization', staff).send({ code: 'VENDE10' }).expect(201);

      const ok = await quote({ items: [{ variantId: shop.blusa, quantity: 1 }], couponCode: 'vende10', fulfillment: delivery }).expect(200);
      expect(ok.body.coupons).toEqual([expect.objectContaining({ code: 'VENDE10', applied: true, discount: '2.00' })]);
      expect(ok.body.totals).toMatchObject({ discountTotal: '2.00', total: '23.70' });

      const bad = await quote({ items: [{ variantId: shop.blusa, quantity: 1 }], couponCode: 'NOEXISTE', fulfillment: delivery }).expect(200);
      expect(bad.body.coupons).toEqual([expect.objectContaining({ code: 'NOEXISTE', applied: false, reason: 'COUPON_NOT_FOUND' })]);
    });
  });

  describe('crear pedido', () => {
    it('cliente registrado, contra entrega: channel backoffice, seller_id, stock reservado y OrderPlaced', async () => {
      const before = await getStock(db, shop.blusa, shop.warehouseId);
      const body = await orderBody({ customer: { userId: shop.customerId }, items: [{ variantId: shop.blusa, quantity: 2 }] }, { notes: 'Llamar antes', expectedTotal: '49.00' });
      const res = await create(body).expect(201);
      expect(res.body).toMatchObject({
        status: 'created',
        paymentStatus: 'cod_pending',
        channel: 'backoffice',
        total: '49.00',
        payment: { method: 'cod', status: 'pending', amount: '49.00' },
      });
      expect(res.body.orderNumber).toMatch(/^\d+$/);
      expect(res.body.payment.paymentUrl).toBeUndefined();

      const order = await orderRow(db, res.body.orderId);
      expect(order).toMatchObject({
        channel: 'backoffice',
        seller_id: shop.userId,
        user_id: shop.customerId,
        cart_id: null,
        payment_method: 'cod',
        notes: 'Llamar antes',
        customer: { name: 'Ana Pérez', phone: '0991234567', idType: '05', idNumber: '1710034065' },
      });
      expect((await reservations(db, res.body.orderId))[0]).toMatchObject({ status: 'active', quantity: 2 });
      expect((await getStock(db, shop.blusa, shop.warehouseId)).reserved).toBe(before.reserved + 2);
      // El cliente recibe las notificaciones normales: el pedido emite OrderPlaced como cualquier otro.
      expect((await outboxEvents(db, shop.tenantId, 'OrderPlaced')).map((e) => e.aggregate_id)).toContain(res.body.orderId);
      const { rows } = await db.query(`SELECT actor_type, actor_id FROM sales.order_status_history WHERE order_id = $1`, [res.body.orderId]);
      expect(rows[0]).toEqual({ actor_type: 'staff', actor_id: shop.userId });
    });

    it('invitado con enlace de pago (card_link): devuelve la URL de la pasarela simulada', async () => {
      const guest = { email: 'Luis@Example.test', firstName: 'Luis', lastName: 'Mora', phone: '0987654321' };
      const body = await orderBody({ customer: { guest }, items: [{ variantId: shop.bolso, quantity: 1 }] }, { paymentMethod: 'card_link' });
      const res = await create(body).expect(201);
      expect(res.body.payment).toMatchObject({ method: 'card_link', status: 'pending' });
      const url = new URL(res.body.payment.paymentUrl);
      expect(url.origin + url.pathname).toBe('http://localhost:8081/pay');
      expect(url.searchParams.get('order')).toBe(String(res.body.orderNumber));
      expect(res.body.payment.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const order = await orderRow(db, res.body.orderId);
      expect(order).toMatchObject({ user_id: null, channel: 'backoffice', seller_id: shop.userId, payment_method: 'card', customer: { name: 'Luis Mora', email: 'luis@example.test' } });
      expect(await paymentRow(db, res.body.payment.id)).toMatchObject({ method: 'card', provider: 'simulator', status: 'pending' });

      // El enlace vence en ASSISTED_PAYMENT_LINK_TTL_MINUTES (24 h), no en los 15 min del checkout
      // web, y la reserva de stock dura eso más el margen de 10 min.
      const hours = (d: Date | string) => (new Date(d).getTime() - Date.now()) / 3_600_000;
      expect(hours(res.body.payment.expiresAt)).toBeCloseTo(24, 1);
      // La pasarela simulada acepta el enlace hasta ese mismo vencimiento (parámetro firmado exp).
      expect(Number(url.searchParams.get('exp'))).toBe(Math.floor(new Date(res.body.payment.expiresAt).getTime() / 1000));
      const [reservation] = await reservations(db, res.body.orderId);
      expect(hours(reservation.expires_at) - hours(res.body.payment.expiresAt)).toBeCloseTo(10 / 60, 1);
    });

    it('transferencia: datos de la cuenta y dónde subir el comprobante (con el client secret)', async () => {
      const body = await orderBody({ customer: { userId: shop.customerId }, items: [{ variantId: shop.bolso, quantity: 1 }] }, { paymentMethod: 'transfer' });
      const res = await create(body).expect(201);
      expect(res.body.payment).toMatchObject({
        method: 'transfer',
        transfer: { reference: expect.stringMatching(/^PAGO-/), voucherUploadPath: `/v1/payments/${res.body.payment.id}/transfer/voucher` },
      });
      // El enlace público existente de Pagos funciona con el client secret.
      await request(server())
        .get(`/v1/payments/${res.body.payment.id}/public`)
        .set('X-Tenant-Id', shop.tenantId)
        .set('X-Payment-Secret', res.body.payment.clientSecret)
        .expect(200);
      // Transferencia asistida: el mayor entre el plazo asistido (24 h) y PAYMENT_TRANSFER_TTL_HOURS (12 h).
      const hours = (new Date(res.body.payment.expiresAt).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeCloseTo(24, 1);
    });

    it('retiro en tienda, sin token de envío', async () => {
      const res = await create({
        customer: { userId: shop.customerId },
        items: [{ variantId: shop.bolso, quantity: 1 }],
        fulfillment: { type: 'pickup', pickupWarehouseId: shop.warehouseId },
        paymentMethod: 'cod',
      }).expect(201);
      expect(res.body).toMatchObject({ total: '30.00', delivery: { fulfillmentType: 'pickup', shipmentId: null } });
    });

    it('idempotencia: misma clave → mismo pedido y pago (Idempotent-Replayed); otro cuerpo → 422', async () => {
      const key = randomUUID();
      const body = await orderBody({ customer: { userId: shop.customerId }, items: [{ variantId: shop.blusa, quantity: 1 }] });
      const [a, b] = await Promise.all([create(body, key), create(body, key)]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.orderId).toBe(b.body.orderId);
      expect([a.headers['idempotent-replayed'], b.headers['idempotent-replayed']].filter(Boolean)).toEqual(['true']);
      expect(await countRows(db, `SELECT count(*) AS n FROM payments.payments WHERE order_id = $1`, [a.body.orderId])).toBe(1);
      expect(await reservations(db, a.body.orderId)).toHaveLength(1);

      const reused = await create({ ...body, paymentMethod: 'transfer' }, key).expect(422);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await create(body, null).expect(422)).body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    it('sin stock al confirmar → 409 CART_NOT_READY y no se crea nada', async () => {
      const s = await createShop(db, { blusa: 3 });
      const auth = `Bearer ${tokenFor(s, SELLER)}`;
      const q = await quote({ items: [{ variantId: s.blusa, quantity: 3 }], fulfillment: delivery }, auth).expect(200);
      const option = q.body.delivery.options[0];
      await setStock(db, s.blusa, s.warehouseId, 1); // otro canal vendió 2 unidades
      const res = await create(
        {
          customer: { userId: s.customerId },
          items: [{ variantId: s.blusa, quantity: 3 }],
          fulfillment: { ...delivery, quoteToken: option.quoteId, slotId: option.slots[0].slotId },
          paymentMethod: 'cod',
        },
        randomUUID(),
        auth,
      ).expect(409);
      expect(res.body.error.code).toBe('CART_NOT_READY');
      expect(await countRows(db, `SELECT count(*) AS n FROM sales.orders WHERE tenant_id = $1`, [s.tenantId])).toBe(0);
    });

    it('cupón que no aplica → 422 con el motivo; cliente inexistente → 404', async () => {
      const body = await orderBody({ customer: { userId: shop.customerId }, items: [{ variantId: shop.blusa, quantity: 1 }] });
      const coupon = await create({ ...body, couponCode: 'NOEXISTE' }).expect(422);
      expect(coupon.body.error.code).toBe('COUPON_NOT_FOUND');
      const missing = await create({ ...body, customer: { userId: randomUUID() } }).expect(404);
      expect(missing.body.error.code).toBe('CUSTOMER_NOT_FOUND');
    });
  });

  describe('comprobante de transferencia subido por el vendedor', () => {
    const PDF = Buffer.from('%PDF-1.4\n% comprobante enviado por WhatsApp\n');

    // Estos pedidos reservan bolsos: se repone stock sin tocar lo ya reservado.
    beforeAll(async () => {
      await db.query(`UPDATE inventory.stock_levels SET on_hand = on_hand + 20 WHERE variant_id = $1 AND warehouse_id = $2`, [shop.bolso, shop.warehouseId]);
    });

    /** Pedido asistido por transferencia (retiro en tienda: sin cotizar envío). */
    async function transferOrder() {
      const res = await create({
        customer: { userId: shop.customerId },
        items: [{ variantId: shop.bolso, quantity: 1 }],
        fulfillment: { type: 'pickup', pickupWarehouseId: shop.warehouseId },
        paymentMethod: 'transfer',
      }).expect(201);
      return res.body as { orderId: string; payment: { id: string } };
    }

    function upload(orderId: string, file: { content: Buffer; name: string; type: string } | null = { content: PDF, name: 'comprobante.pdf', type: 'application/pdf' }, auth = seller) {
      const req = request(server()).post(`/v1/assisted-orders/${orderId}/transfer-voucher`).set('Authorization', auth).field('reference', 'TRX-5511');
      if (file) req.attach('file', file.content, { filename: file.name, contentType: file.type });
      return req;
    }

    it('sin client secret: el pago queda pending por verificar, auditado con el vendedor y aprobable por quien verifica', async () => {
      const order = await transferOrder();
      const res = await upload(order.orderId).expect(200);
      expect(res.body).toMatchObject({ id: order.payment.id, method: 'transfer', status: 'pending' });

      const { rows: transfer } = await db.query(`SELECT bank_name, reference, voucher_key FROM payments.bank_transfers WHERE payment_id = $1`, [order.payment.id]);
      expect(transfer[0]).toMatchObject({ bank_name: 'No indicado (subido por el vendedor)', reference: 'TRX-5511', voucher_key: expect.stringContaining(order.payment.id) });
      const { rows: events } = await db.query(`SELECT payload FROM payments.payment_events WHERE payment_id = $1 AND event_type = 'voucher_submitted'`, [order.payment.id]);
      expect(events[0].payload).toMatchObject({ submittedBy: `staff:${shop.userId}` });
      const { rows: audit } = await db.query(
        `SELECT actor_id, actor_type, entity_type, after->>'outcome' AS outcome FROM platform.audit_log WHERE tenant_id = $1 AND action = 'orders.assisted.transfer_voucher' AND entity_id = $2`,
        [shop.tenantId, order.orderId],
      );
      expect(audit).toEqual([{ actor_id: shop.userId, actor_type: 'staff', entity_type: 'order', outcome: 'ok' }]);

      // Un segundo comprobante no reemplaza al que está en revisión.
      expect((await upload(order.orderId).expect(409)).body.error.code).toBe('VOUCHER_ALREADY_SUBMITTED');
      // Lo verifica otra persona con payments.transfer.verify (el vendedor no tiene ese permiso).
      await request(server()).post(`/v1/payments/${order.payment.id}/transfer/approve`).set('Authorization', seller).expect(403);
      const verifier = `Bearer ${tokenFor(shop, ['payments.read', 'payments.transfer.verify'])}`;
      await request(server()).post(`/v1/payments/${order.payment.id}/transfer/approve`).set('Authorization', verifier).expect(200);
    });

    it('pedido del checkout web → 404; pedido inexistente → 404; contra entrega → 409 NOT_A_TRANSFER', async () => {
      const web = await transferOrder();
      await db.query(`UPDATE sales.orders SET channel = 'web', seller_id = NULL WHERE id = $1`, [web.orderId]);
      expect((await upload(web.orderId).expect(404)).body.error.code).toBe('ORDER_NOT_FOUND');
      expect((await paymentRow(db, web.payment.id)).status).toBe('requires_action');
      expect((await upload(randomUUID()).expect(404)).body.error.code).toBe('ORDER_NOT_FOUND');

      const cod = await create({
        customer: { userId: shop.customerId },
        items: [{ variantId: shop.bolso, quantity: 1 }],
        fulfillment: { type: 'pickup', pickupWarehouseId: shop.warehouseId },
        paymentMethod: 'cod',
      }).expect(201);
      expect((await upload(cod.body.orderId).expect(409)).body.error.code).toBe('NOT_A_TRANSFER');
    });

    it('rol sin permiso → 403', async () => {
      const order = await transferOrder();
      const auth = `Bearer ${tokenFor(shop, [...findSystemRole('warehouse')!.permissions])}`;
      await upload(order.orderId, undefined, auth).expect(403);
      expect((await paymentRow(db, order.payment.id)).status).toBe('requires_action');
    });

    it('archivo inválido (tipo real distinto, sin archivo) → 422 y el pago sigue esperando el comprobante', async () => {
      const order = await transferOrder();
      const fake = await upload(order.orderId, { content: Buffer.from('MZ ejecutable'), name: 'comprobante.pdf', type: 'application/pdf' }).expect(422);
      expect(fake.body.error.code).toBe('VOUCHER_TYPE');
      const missing = await upload(order.orderId, null).expect(422);
      expect(missing.body.error.code).toBe('VOUCHER_REQUIRED');
      expect((await paymentRow(db, order.payment.id)).status).toBe('requires_action');
    });
  });

  describe('permisos y listado', () => {
    it.each(['warehouse', 'support'])('rol %s → 403 en todos los endpoints', async (role) => {
      const auth = `Bearer ${tokenFor(shop, [...findSystemRole(role)!.permissions])}`;
      await request(server()).get('/v1/assisted-orders/customers').query({ q: 'ana' }).set('Authorization', auth).expect(403);
      await quote({ items: [{ variantId: shop.blusa, quantity: 1 }], fulfillment: delivery }, auth).expect(403);
      await create({}, randomUUID(), auth).expect(403);
      await request(server()).get('/v1/assisted-orders').set('Authorization', auth).expect(403);
    });

    it('rol vendedor del sistema sí puede', async () => {
      const auth = `Bearer ${tokenFor(shop, [...findSystemRole('seller')!.permissions])}`;
      await request(server()).get('/v1/assisted-orders').set('Authorization', auth).expect(200);
    });

    it('mine=true: solo los del vendedor; mine=false: todo el canal backoffice', async () => {
      const otherSeller = (await db.query<{ id: string }>(`INSERT INTO iam.users (tenant_id, user_type, email) VALUES ($1, 'staff', $2) RETURNING id`, [
        shop.tenantId,
        `vendedor+${randomUUID().slice(0, 8)}@example.test`,
      ])).rows[0].id;
      const other = `Bearer ${tokenFor({ tenantId: shop.tenantId, userId: otherSeller }, SELLER)}`;
      const created = await create(
        {
          customer: { userId: shop.customerId },
          items: [{ variantId: shop.bolso, quantity: 1 }],
          fulfillment: { type: 'pickup', pickupWarehouseId: shop.warehouseId },
          paymentMethod: 'cod',
        },
        randomUUID(),
        other,
      ).expect(201);

      const mine = await request(server()).get('/v1/assisted-orders').query({ mine: 'true' }).set('Authorization', other).expect(200);
      expect(mine.body.map((o: { id: string }) => o.id)).toEqual([created.body.orderId]);

      const all = await request(server()).get('/v1/assisted-orders').query({ mine: 'false', limit: 100 }).set('Authorization', other).expect(200);
      expect(all.body.length).toBeGreaterThan(1);
      expect(all.body.every((o: { channel: string }) => o.channel === 'backoffice')).toBe(true);
      expect(all.body.map((o: { sellerId: string }) => o.sellerId)).toEqual(expect.arrayContaining([shop.userId, otherSeller]));

      const page = await request(server()).get('/v1/assisted-orders').query({ mine: 'false', limit: 1, offset: 1 }).set('Authorization', other).expect(200);
      expect(page.body).toHaveLength(1);
    });
  });
});
