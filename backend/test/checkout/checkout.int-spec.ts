import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { canonicalParams, hmacHex } from '../../libs/modules/payments/infrastructure/simulator/paysim-signature';
import { Database, OutboxRelay } from '../../libs/shared-kernel';
import { createWarehouse, getStock, outboxEvents, PROMOTION_PERMISSIONS, setStock, tokenFor } from '../support/fixtures';
import {
  checkoutBody,
  countRows,
  createShop,
  customerCart,
  deliveryBody,
  GUAYAQUIL,
  guestCart,
  orderRow,
  paymentRow,
  postCheckout,
  reservations,
  Shop,
  stockQty,
} from '../support/shop';
import { createTestApp } from '../support/test-app';

describe('Checkout (HTTP + PostgreSQL)', () => {
  let app: INestApplication;
  let db: Database;
  let relay: OutboxRelay;

  beforeAll(async () => {
    ({ app, db, relay } = await createTestApp({ withConsumers: true }));
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  describe('pago en línea (tarjeta, pasarela simulada)', () => {
    let shop: Shop;
    beforeAll(async () => {
      shop = await createShop(db, { blusa: 10 });
    });

    it('en una transacción: recalcula, reserva, crea el pedido y el pago, y convierte el carrito', async () => {
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 2 }]);
      const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie }, { expectedTotal: '49.00' })).expect(201);

      // 2 × 20.00 = 40.00 + IVA 6.00 + envío motorizado 3.00
      expect(res.body).toMatchObject({
        status: 'created',
        paymentStatus: 'pending',
        totals: { subtotal: '40.00', discountTotal: '0.00', taxTotal: '6.00', shippingTotal: '3.00', giftCardTotal: '0.00', total: '49.00' },
        payment: { payment: { method: 'card', status: 'pending', amount: '49.00' }, nextAction: { type: 'redirect' } },
      });
      const { orderId } = res.body;
      const paymentId = res.body.payment.payment.id;
      expect(res.body.payment.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // La URL de la pasarela lleva el cobro firmado con HMAC (el simulador rechaza si se altera).
      const url = new URL(res.body.payment.nextAction.url);
      expect(url.origin + url.pathname).toBe('http://localhost:8081/pay');
      const params = Object.fromEntries(url.searchParams);
      const { sig, ...signed } = params;
      expect(signed).toMatchObject({ amount: '49.00', currency: 'USD', method: 'card', order: String(res.body.orderNumber) });
      expect(sig).toBe(hmacHex(process.env.PAYSIM_SECRET!, canonicalParams(signed)));

      const order = await orderRow(db, orderId);
      expect(order).toMatchObject({ status: 'created', payment_status: 'pending', payment_method: 'card', total: '49.00', source_warehouse_id: shop.warehouseId });
      expect(await getStock(db, shop.blusa, shop.warehouseId)).toMatchObject({ on_hand: 10, reserved: 2, available: 8 });

      // El pago vence en 15 min y la reserva 10 min después, así una captura tardía aún la encuentra.
      const payment = await paymentRow(db, paymentId);
      expect(payment).toMatchObject({ order_id: orderId, provider: 'simulator', status: 'pending', provider_ref: params.ref });
      const [reservation] = await reservations(db, orderId);
      expect(reservation.status).toBe('active');
      const gapMinutes = (reservation.expires_at.getTime() - payment.expires_at.getTime()) / 60_000;
      expect(gapMinutes).toBeCloseTo(10, 0);

      const { rows } = await db.query(`SELECT status FROM sales.carts WHERE id = $1`, [order.cart_id]);
      expect(rows[0].status).toBe('converted');
      expect((await outboxEvents(db, shop.tenantId, 'OrderPlaced')).map((e) => e.aggregate_id)).toContain(orderId);
    });

    it('doble clic en "Pagar": dos peticiones simultáneas con la misma clave → un pedido y un pago', async () => {
      const before = await getStock(db, shop.blusa, shop.warehouseId);
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
      const key = randomUUID();
      const body = await deliveryBody(app, shop.tenantId, { cookie });

      const [a, b] = await Promise.all([
        postCheckout(app, shop.tenantId, { cookie }, body, key),
        postCheckout(app, shop.tenantId, { cookie }, body, key),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.orderId).toBe(b.body.orderId);
      expect(a.body.payment.payment.id).toBe(b.body.payment.payment.id);
      expect([a.headers['idempotent-replayed'], b.headers['idempotent-replayed']].filter(Boolean)).toEqual(['true']);

      // Un tercer clic, ya confirmado el primero, también devuelve lo mismo.
      const c = await postCheckout(app, shop.tenantId, { cookie }, body, key).expect(201);
      expect(c.headers['idempotent-replayed']).toBe('true');
      expect(c.body).toEqual(a.body);

      const orderId = a.body.orderId;
      expect(await countRows(db, `SELECT count(*) AS n FROM sales.orders WHERE cart_id = (SELECT cart_id FROM sales.orders WHERE id = $1)`, [orderId])).toBe(1);
      expect(await countRows(db, `SELECT count(*) AS n FROM payments.payments WHERE order_id = $1`, [orderId])).toBe(1);
      expect(await reservations(db, orderId)).toHaveLength(1);
      expect((await getStock(db, shop.blusa, shop.warehouseId)).reserved).toBe(before.reserved + 1);
    });

    it('misma clave con otro cuerpo → 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
      const key = randomUUID();
      const body = await deliveryBody(app, shop.tenantId, { cookie });
      await postCheckout(app, shop.tenantId, { cookie }, body, key).expect(201);
      const res = await postCheckout(app, shop.tenantId, { cookie }, { ...body, paymentMethod: 'transfer' }, key).expect(422);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('sin Idempotency-Key → 422', async () => {
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
      const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie }), null).expect(422);
      expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    it('si el total cambió respecto del que vio el cliente → 409 y no se crea nada', async () => {
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
      const before = await stockQty(db, shop.blusa, shop.warehouseId);
      const body = await deliveryBody(app, shop.tenantId, { cookie });
      const res = await postCheckout(app, shop.tenantId, { cookie }, { ...body, expectedTotal: '20.00' }).expect(409);
      expect(res.body.error).toMatchObject({ code: 'CHECKOUT_TOTAL_CHANGED', details: { expected: '20.00', actual: '26.00' } });
      expect(await stockQty(db, shop.blusa, shop.warehouseId)).toEqual(before);
      // El carrito sigue activo: el cliente puede corregir y volver a pagar.
      await postCheckout(app, shop.tenantId, { cookie }, { ...body, expectedTotal: '26.00' }).expect(201);
    });
  });

  describe('todo o nada', () => {
    it('si la gift card falla después de reservar y canjear el cupón, se revierte todo', async () => {
      const shop = await createShop(db, { blusa: 5 });
      const staff = `Bearer ${tokenFor(shop, PROMOTION_PERMISSIONS)}`;
      const promo = await request(server())
        .post('/v1/promotions')
        .set('Authorization', staff)
        .send({ name: 'Diez', requiresCoupon: true, startsAt: '2026-01-01T00:00:00Z', type: 'percent', benefit: { percent: 10 } })
        .expect(201);
      await request(server()).post(`/v1/promotions/${promo.body.id}/coupons`).set('Authorization', staff).send({ code: 'DIEZ', maxUses: 1 }).expect(201);
      const card = await request(server()).post('/v1/gift-cards').set('Authorization', staff).send({ amount: '10.00' }).expect(201);
      await request(server()).post(`/v1/gift-cards/${card.body.giftCard.id}/block`).set('Authorization', staff).expect(200);

      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 2 }]);
      await request(server()).post('/v1/cart/coupons').set('X-Tenant-Id', shop.tenantId).set('Cookie', `cart_token=${cookie}`).send({ code: 'DIEZ' }).expect(200);

      // La gift card se canjea DESPUÉS de reservar el stock y tomar el cupo del cupón: el error
      // prueba que esos pasos ya habían escrito y se revirtieron con la transacción.
      const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie }, { giftCardCode: card.body.code })).expect(409);
      expect(res.body.error.code).toBe('GIFT_CARD_BLOCKED');

      expect(await getStock(db, shop.blusa, shop.warehouseId)).toMatchObject({ on_hand: 5, reserved: 0 });
      expect(await countRows(db, `SELECT used_count AS n FROM sales.coupons WHERE promotion_id = $1`, [promo.body.id])).toBe(0);
      expect(await countRows(db, `SELECT count(*) AS n FROM sales.orders WHERE tenant_id = $1`, [shop.tenantId])).toBe(0);
      expect(await countRows(db, `SELECT count(*) AS n FROM payments.payments WHERE tenant_id = $1`, [shop.tenantId])).toBe(0);
      expect(await countRows(db, `SELECT count(*) AS n FROM platform.outbox_events WHERE tenant_id = $1`, [shop.tenantId])).toBe(0);
    });

    it('stock insuficiente al confirmar → 409 CART_NOT_READY', async () => {
      const shop = await createShop(db, { blusa: 3 });
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 3 }]);
      const body = await deliveryBody(app, shop.tenantId, { cookie });
      await setStock(db, shop.blusa, shop.warehouseId, 1); // otro canal vendió 2 unidades
      const res = await postCheckout(app, shop.tenantId, { cookie }, body).expect(409);
      expect(res.body.error.code).toBe('CART_NOT_READY');
    });
  });

  describe('contra entrega, retiro en tienda y gift card', () => {
    it('contra entrega: pedido cod_pending, pago sin vencimiento y la reserva se confirma por OrderPlaced', async () => {
      const shop = await createShop(db, { blusa: 4 });
      const bearer = await customerCart(app, shop, [{ variantId: shop.blusa, quantity: 1 }]);
      const res = await postCheckout(app, shop.tenantId, { bearer }, await deliveryBody(app, shop.tenantId, { bearer }, { paymentMethod: 'cod' })).expect(201);
      expect(res.body).toMatchObject({ paymentStatus: 'cod_pending', payment: { payment: { method: 'cod', status: 'pending', expiresAt: null }, nextAction: { type: 'cash_on_delivery' } } });
      expect((await orderRow(db, res.body.orderId)).user_id).toBe(shop.customerId);

      await relay.drain({ tenantId: shop.tenantId });
      expect((await reservations(db, res.body.orderId))[0].status).toBe('consumed');
      expect(await getStock(db, shop.blusa, shop.warehouseId)).toMatchObject({ on_hand: 3, reserved: 0 });
    });

    it('contra entrega entregado: el pago COD se captura al entregar', async () => {
      const shop = await createShop(db, { blusa: 4 });
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
      const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie }, { paymentMethod: 'cod' })).expect(201);
      const staff = `Bearer ${tokenFor(shop, ['orders.status.update'])}`;
      for (const [to, version] of [['preparing', 0], ['shipped', 1], ['in_transit', 2], ['delivered', 3]] as const) {
        await request(server()).post(`/v1/orders/${res.body.orderId}/status`).set('Authorization', staff).send({ to, version }).expect(200);
      }
      await relay.drain({ tenantId: shop.tenantId });
      expect(await paymentRow(db, res.body.payment.payment.id)).toMatchObject({ status: 'captured' });
      expect(await orderRow(db, res.body.orderId)).toMatchObject({ status: 'delivered', payment_status: 'paid' });
    });

    it('retiro en tienda: reserva en la tienda elegida y sin envío', async () => {
      const shop = await createShop(db, { blusa: 0 });
      const store = await createWarehouse(db, shop.tenantId, { shipsOnline: false });
      await setStock(db, shop.blusa, store, 2);
      // El carrito valida contra bodegas que despachan online: se da stock online para poder agregar.
      await setStock(db, shop.blusa, shop.warehouseId, 1);
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
      const res = await postCheckout(
        app,
        shop.tenantId,
        { cookie },
        { customer: checkoutBody().customer, fulfillmentType: 'pickup', pickupWarehouseId: store, paymentMethod: 'card' },
      ).expect(201);
      expect(res.body.totals).toMatchObject({ shippingTotal: '0.00', total: '23.00' });
      expect(await orderRow(db, res.body.orderId)).toMatchObject({ fulfillment_type: 'pickup', source_warehouse_id: store });
      expect(await getStock(db, shop.blusa, store)).toMatchObject({ reserved: 1 });
      expect(await getStock(db, shop.blusa, shop.warehouseId)).toMatchObject({ reserved: 0 });
    });

    it('gift card que cubre todo: pago gift_card capturado al instante y el pedido pasa a pagado', async () => {
      const shop = await createShop(db, { bolso: 3 });
      const staff = `Bearer ${tokenFor(shop, PROMOTION_PERMISSIONS)}`;
      const card = await request(server()).post('/v1/gift-cards').set('Authorization', staff).send({ amount: '50.00' }).expect(201);
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.bolso, quantity: 1 }]);
      // 30.00 (IVA 0 %) + 5.50 courier (Guayaquil, fuera de la zona propia) = 35.50, todo con la gift card
      const body = await deliveryBody(app, shop.tenantId, { cookie }, { shippingAddress: GUAYAQUIL, giftCardCode: card.body.code, expectedTotal: '0.00' });
      expect(body.fulfillmentType).toBe('courier');
      const res = await postCheckout(app, shop.tenantId, { cookie }, body).expect(201);
      expect(res.body).toMatchObject({
        totals: { total: '0.00', giftCardTotal: '35.50' },
        payment: { payment: { method: 'gift_card', status: 'captured', amount: '35.50' }, nextAction: { type: 'none' } },
      });
      await relay.drain({ tenantId: shop.tenantId });
      expect(await orderRow(db, res.body.orderId)).toMatchObject({ status: 'paid', payment_status: 'paid', payment_method: 'gift_card' });
      expect((await reservations(db, res.body.orderId))[0].status).toBe('consumed');
      const balance = await request(server()).post('/v1/gift-cards/balance').set('X-Tenant-Id', shop.tenantId).send({ code: card.body.code }).expect(200);
      expect(balance.body.balance).toBe('14.50');
    });
  });

  it('un token de staff no puede hacer checkout', async () => {
    const shop = await createShop(db);
    await request(server())
      .post('/v1/checkout')
      .set('Authorization', `Bearer ${tokenFor(shop, [])}`)
      .set('Idempotency-Key', randomUUID())
      .send(checkoutBody({ deliveryQuoteId: 'x'.repeat(40) }))
      .expect(403);
  });
});
