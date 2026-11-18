import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Database, OutboxRelay } from '../../libs/shared-kernel';
import { getStock, outboxEvents, PROMOTION_PERMISSIONS, tokenFor } from '../support/fixtures';
import {
  deliveryBody,
  countRows,
  createShop,
  guestCart,
  orderRow,
  paymentRow,
  paysimEvent,
  postCheckout,
  postWebhook,
  referenceFrom,
  reservations,
  Shop,
  stockQty,
} from '../support/shop';
import { createTestApp } from '../support/test-app';

interface CardCheckout {
  orderId: string;
  paymentId: string;
  reference: string;
  amount: string;
}

describe('Webhooks de la pasarela simulada (HTTP + PostgreSQL)', () => {
  let app: INestApplication;
  let db: Database;
  let relay: OutboxRelay;
  let shop: Shop;

  beforeAll(async () => {
    ({ app, db, relay } = await createTestApp({ withConsumers: true }));
    shop = await createShop(db, { blusa: 50 });
  });

  afterAll(async () => {
    await app.close();
  });

  async function cardCheckout(quantity = 1, extra: Record<string, unknown> = {}, cookieFor?: string): Promise<CardCheckout> {
    const cookie = cookieFor ?? (await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity }]));
    const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie }, extra)).expect(201);
    return {
      orderId: res.body.orderId,
      paymentId: res.body.payment.payment.id,
      reference: referenceFrom(res.body.payment.nextAction.url),
      amount: res.body.totals.total,
    };
  }

  const inbox = async (externalId: string) =>
    (await db.query(`SELECT * FROM payments.webhook_inbox WHERE provider = 'simulator' AND external_id = $1`, [externalId])).rows;
  const capturedEvents = async (paymentId: string) =>
    (await outboxEvents(db, shop.tenantId, 'PaymentCaptured')).filter((e) => e.aggregate_id === paymentId);

  it('aprobado: guarda en webhook_inbox, captura el pago, emite PaymentCaptured y el pedido pasa a pagado', async () => {
    const c = await cardCheckout(2);
    const body = paysimEvent({ type: 'payment.approved', reference: c.reference, amount: c.amount });
    const res = await postWebhook(app, body).expect(200);
    expect(res.body).toMatchObject({ received: true, outcome: 'processed', paymentId: c.paymentId, status: 'captured' });

    const [row] = await inbox(JSON.parse(body).id);
    expect(row).toMatchObject({ signature_valid: true, error: null });
    expect(row.processed_at).toBeInstanceOf(Date);
    expect(await paymentRow(db, c.paymentId)).toMatchObject({ status: 'captured', authorization_code: '654321', card_brand: 'visa', card_last4: '4242' });
    const events = await capturedEvents(c.paymentId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ orderId: c.orderId, amount: c.amount, method: 'card', provider: 'simulator' });

    // El relay publica: Pedidos → paid (OrderPaid) → Inventario confirma la reserva (salida física).
    const stockBefore = await getStock(db, shop.blusa, shop.warehouseId);
    await relay.drain({ tenantId: shop.tenantId });
    expect(await orderRow(db, c.orderId)).toMatchObject({ status: 'paid', payment_status: 'paid' });
    expect((await reservations(db, c.orderId))[0].status).toBe('consumed');
    expect(await getStock(db, shop.blusa, shop.warehouseId)).toMatchObject({ on_hand: stockBefore.on_hand - 2, reserved: stockBefore.reserved - 2 });
  });

  describe('webhook duplicado', () => {
    it('el mismo external_id dos veces: la segunda responde duplicate y no vuelve a procesar', async () => {
      const c = await cardCheckout();
      const body = paysimEvent({ type: 'payment.approved', reference: c.reference, amount: c.amount });
      await postWebhook(app, body).expect(200);
      const again = await postWebhook(app, body).expect(200);
      expect(again.body).toMatchObject({ received: true, outcome: 'duplicate' });
      expect(await inbox(JSON.parse(body).id)).toHaveLength(1);
      expect(await capturedEvents(c.paymentId)).toHaveLength(1);
      expect(await countRows(db, `SELECT count(*) AS n FROM payments.payment_events WHERE payment_id = $1 AND event_type = 'captured'`, [c.paymentId])).toBe(1);
    });

    it('cinco entregas simultáneas del mismo evento: una sola captura', async () => {
      const c = await cardCheckout();
      const body = paysimEvent({ type: 'payment.approved', reference: c.reference, amount: c.amount });
      const results = await Promise.all(Array.from({ length: 5 }, () => postWebhook(app, body)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(results.map((r) => r.body.outcome).sort()).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'processed']);
      expect(await capturedEvents(c.paymentId)).toHaveLength(1);
    });

    it('otro evento de aprobación para un pago ya capturado queda sin efecto (ALREADY_CAPTURED)', async () => {
      const c = await cardCheckout();
      await postWebhook(app, paysimEvent({ type: 'payment.approved', reference: c.reference, amount: c.amount })).expect(200);
      const second = paysimEvent({ type: 'payment.approved', reference: c.reference, amount: c.amount });
      const res = await postWebhook(app, second).expect(200);
      expect(res.body).toMatchObject({ outcome: 'ignored', reason: 'ALREADY_CAPTURED' });
      expect((await inbox(JSON.parse(second).id))[0].error).toBe('ALREADY_CAPTURED');
      expect(await capturedEvents(c.paymentId)).toHaveLength(1);
    });
  });

  describe('firma inválida', () => {
    it('401: no se guarda nada en el inbox (se verifica la firma antes de leer el cuerpo) y el pago no cambia', async () => {
      const c = await cardCheckout();
      const body = paysimEvent({ type: 'payment.approved', reference: c.reference, amount: c.amount });
      const res = await postWebhook(app, body, { secret: 'secreto-equivocado' }).expect(401);
      expect(res.body.message).toBe('Firma del webhook inválida');
      expect(await inbox(JSON.parse(body).id)).toEqual([]);
      // Un cuerpo basura sin firma válida también es 401 (antes de interpretarlo), no 422.
      await postWebhook(app, JSON.stringify({ hola: 'mundo' }), { secret: 'secreto-equivocado' }).expect(401);
      // El nombre de la pasarela se valida antes de usarlo.
      await request(app.getHttpServer()).post('/v1/webhooks/payments/NO_VALIDA!').set('Content-Type', 'application/json').send(body).expect(400);
      expect(await paymentRow(db, c.paymentId)).toMatchObject({ status: 'pending' });
      expect(await capturedEvents(c.paymentId)).toHaveLength(0);
    });

    it('sin header de firma o con cuerpo alterado → 401', async () => {
      const c = await cardCheckout();
      const body = paysimEvent({ type: 'payment.approved', reference: c.reference, amount: c.amount });
      await postWebhook(app, body, { signature: null }).expect(401);
      const tampered = paysimEvent({ type: 'payment.approved', reference: c.reference, amount: '0.01' });
      const validForOriginal = (await import('../../libs/modules/payments/infrastructure/simulator/paysim-signature')).signWebhook(
        process.env.PAYSIM_SECRET!,
        body,
      );
      await postWebhook(app, tampered, { signature: validForOriginal }).expect(401);
      expect(await paymentRow(db, c.paymentId)).toMatchObject({ status: 'pending' });
    });

    it('firma auténtica pero vieja (replay de hace más de 5 min) → 401', async () => {
      const c = await cardCheckout();
      const body = paysimEvent({ type: 'payment.approved', reference: c.reference, amount: c.amount });
      await postWebhook(app, body, { timestamp: Math.floor(Date.now() / 1000) - 600 }).expect(401);
      expect(await paymentRow(db, c.paymentId)).toMatchObject({ status: 'pending' });
    });

    it('un id recibido antes con firma falsa no bloquea al evento legítimo con ese id', async () => {
      const c = await cardCheckout();
      const body = paysimEvent({ type: 'payment.approved', reference: c.reference, amount: c.amount });
      await postWebhook(app, body, { secret: 'atacante' }).expect(401);
      const res = await postWebhook(app, body).expect(200);
      expect(res.body.outcome).toBe('processed');
      expect(await inbox(JSON.parse(body).id)).toMatchObject([{ signature_valid: true, error: null }]);
      expect(await paymentRow(db, c.paymentId)).toMatchObject({ status: 'captured' });
    });
  });

  describe('pago rechazado', () => {
    it('falla el pago (PaymentFailed), se cancela el pedido, se libera el stock y se devuelve el cupón', async () => {
      const staff = `Bearer ${tokenFor(shop, PROMOTION_PERMISSIONS)}`;
      const promo = await request(app.getHttpServer())
        .post('/v1/promotions')
        .set('Authorization', staff)
        .send({ name: 'Cinco', requiresCoupon: true, startsAt: '2026-01-01T00:00:00Z', type: 'fixed', benefit: { amount: '5' } })
        .expect(201);
      await request(app.getHttpServer()).post(`/v1/promotions/${promo.body.id}/coupons`).set('Authorization', staff).send({ code: 'CINCO' }).expect(201);
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 3 }]);
      await request(app.getHttpServer()).post('/v1/cart/coupons').set('X-Tenant-Id', shop.tenantId).set('Cookie', `cart_token=${cookie}`).send({ code: 'CINCO' }).expect(200);

      await relay.drain({ tenantId: shop.tenantId }); // capturas pendientes de tests anteriores
      const stockBefore = await stockQty(db, shop.blusa, shop.warehouseId);
      const c = await cardCheckout(3, {}, cookie);
      expect(await getStock(db, shop.blusa, shop.warehouseId)).toMatchObject({ reserved: stockBefore.reserved + 3 });
      expect(await countRows(db, `SELECT used_count AS n FROM sales.coupons WHERE promotion_id = $1`, [promo.body.id])).toBe(1);

      const body = paysimEvent({ type: 'payment.rejected', reference: c.reference, amount: c.amount, failureCode: 'INSUFFICIENT_FUNDS' });
      const res = await postWebhook(app, body).expect(200);
      expect(res.body).toMatchObject({ outcome: 'processed', status: 'failed' });
      expect(await paymentRow(db, c.paymentId)).toMatchObject({ status: 'failed', failure_code: 'INSUFFICIENT_FUNDS', failure_message: 'Fondos insuficientes' });
      const failed = (await outboxEvents(db, shop.tenantId, 'PaymentFailed')).filter((e) => e.aggregate_id === c.paymentId);
      expect(failed).toHaveLength(1);

      await relay.drain({ tenantId: shop.tenantId });
      expect(await orderRow(db, c.orderId)).toMatchObject({ status: 'cancelled', payment_status: 'failed', cancel_reason: 'Pago rechazado: Fondos insuficientes' });
      expect((await reservations(db, c.orderId))[0].status).toBe('released');
      expect(await stockQty(db, shop.blusa, shop.warehouseId)).toEqual(stockBefore);
      expect(await countRows(db, `SELECT used_count AS n FROM sales.coupons WHERE promotion_id = $1`, [promo.body.id])).toBe(0);

      // Una aprobación que llegue después no revive el pago.
      const late = await postWebhook(app, paysimEvent({ type: 'payment.approved', reference: c.reference, amount: c.amount })).expect(200);
      expect(late.body).toMatchObject({ outcome: 'ignored', reason: 'PAYMENT_NOT_OPEN:failed' });
    });
  });

  describe('sin efecto', () => {
    it('monto distinto al del pago → no captura (AMOUNT_MISMATCH) y queda en la bitácora', async () => {
      const c = await cardCheckout();
      const body = paysimEvent({ type: 'payment.approved', reference: c.reference, amount: '0.50' });
      const res = await postWebhook(app, body).expect(200);
      expect(res.body).toMatchObject({ outcome: 'ignored', reason: 'AMOUNT_MISMATCH' });
      expect(await paymentRow(db, c.paymentId)).toMatchObject({ status: 'pending' });
      expect(await countRows(db, `SELECT count(*) AS n FROM payments.payment_events WHERE payment_id = $1 AND event_type = 'webhook_amount_mismatch'`, [c.paymentId])).toBe(1);
    });

    it('referencia desconocida → PAYMENT_NOT_FOUND', async () => {
      const res = await postWebhook(app, paysimEvent({ type: 'payment.approved', reference: 'ps_noexiste', amount: '1.00' })).expect(200);
      expect(res.body).toMatchObject({ outcome: 'ignored', reason: 'PAYMENT_NOT_FOUND' });
    });

    it('cuerpo sin el formato de la pasarela → 422; pasarela desconocida → 404', async () => {
      await postWebhook(app, JSON.stringify({ hola: 'mundo' })).expect(422);
      await request(app.getHttpServer()).post('/v1/webhooks/payments/datafast').set('Content-Type', 'application/json').send(paysimEvent({ type: 'payment.approved', reference: 'x', amount: '1.00' })).expect(404);
    });
  });
});
