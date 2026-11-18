import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PaymentService } from '../../libs/modules/payments/application/payment.service';
import { Database, OutboxRelay } from '../../libs/shared-kernel';
import { getStock, outboxEvents, tokenFor } from '../support/fixtures';
import {
  deliveryBody,
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

const PDF = Buffer.from('%PDF-1.4\n% comprobante de prueba\n');

describe('Transferencia con comprobante y vencimiento de pagos (HTTP + PostgreSQL)', () => {
  let app: INestApplication;
  let db: Database;
  let relay: OutboxRelay;
  let shop: Shop;
  let verifier: string;
  let reader: string;

  beforeAll(async () => {
    ({ app, db, relay } = await createTestApp({ withConsumers: true }));
    shop = await createShop(db, { blusa: 30 });
    verifier = `Bearer ${tokenFor(shop, ['payments.read', 'payments.transfer.verify'])}`;
    reader = `Bearer ${tokenFor(shop, ['payments.read'])}`;
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  async function transferCheckout(quantity = 1) {
    const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity }]);
    const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie }, { paymentMethod: 'transfer' })).expect(201);
    return { orderId: res.body.orderId as string, paymentId: res.body.payment.payment.id as string, secret: res.body.payment.clientSecret as string, body: res.body };
  }

  const uploadVoucher = (paymentId: string, secret: string | null, file: { content: Buffer; name: string; type: string } | null = { content: PDF, name: 'comprobante.pdf', type: 'application/pdf' }) => {
    const req = request(server()).post(`/v1/payments/${paymentId}/transfer/voucher`).set('X-Tenant-Id', shop.tenantId).field('bankName', 'Banco Pichincha').field('reference', 'TRX-889911');
    if (secret) req.set('X-Payment-Secret', secret);
    if (file) req.attach('voucher', file.content, { filename: file.name, contentType: file.type });
    return req;
  };

  describe('transferencia', () => {
    it('checkout: requires_action con los datos de la cuenta y vencimiento', async () => {
      const t = await transferCheckout();
      expect(t.body.payment).toMatchObject({
        payment: { method: 'transfer', status: 'requires_action' },
        nextAction: { type: 'bank_transfer', account: expect.stringContaining('Banco Pichincha'), reference: expect.stringMatching(/^PAGO-/) },
      });
      expect(await paymentRow(db, t.paymentId)).toMatchObject({ provider: 'manual' });
    });

    it('subir comprobante exige el client secret; con él queda pendiente de verificación', async () => {
      const t = await transferCheckout();
      await uploadVoucher(t.paymentId, null).expect(404);
      await uploadVoucher(t.paymentId, 'secreto-inventado').expect(404);
      await uploadVoucher(t.paymentId, t.secret, null).expect(422);
      const exe = await uploadVoucher(t.paymentId, t.secret, { content: Buffer.from('MZ'), name: 'virus.exe', type: 'application/x-msdownload' }).expect(422);
      expect(exe.body.error.code).toBe('VOUCHER_TYPE');

      const res = await uploadVoucher(t.paymentId, t.secret).expect(200);
      expect(res.body).toMatchObject({ id: t.paymentId, status: 'pending' });

      // El cliente (o invitado) consulta el estado con el mismo secret.
      const status = await request(server()).get(`/v1/payments/${t.paymentId}/public`).set('X-Tenant-Id', shop.tenantId).set('X-Payment-Secret', t.secret).expect(200);
      expect(status.body.payment.status).toBe('pending');

      // En revisión ya no se reemplaza el comprobante (el backoffice aprobaría otro archivo).
      const again = await uploadVoucher(t.paymentId, t.secret).expect(409);
      expect(again.body.error.code).toBe('VOUCHER_ALREADY_SUBMITTED');
      const events = await db.query(`SELECT event_type FROM payments.payment_events WHERE payment_id = $1 ORDER BY id`, [t.paymentId]);
      expect(events.rows.map((r) => r.event_type)).toEqual(['created', 'voucher_submitted']);
    });

    it('backoffice: cola de verificación, ver el comprobante y aprobar → pagado', async () => {
      const t = await transferCheckout(2);
      await uploadVoucher(t.paymentId, t.secret).expect(200);

      const queue = await request(server()).get('/v1/payments?method=transfer&status=pending').set('Authorization', reader).expect(200);
      expect(queue.body.map((p: { id: string }) => p.id)).toContain(t.paymentId);
      // Datos para conciliar contra el extracto bancario, sin abrir el detalle de cada pago.
      const row = queue.body.find((p: { id: string }) => p.id === t.paymentId);
      expect(row).toMatchObject({
        method: 'transfer',
        status: 'pending',
        orderId: t.orderId,
        amount: expect.stringMatching(/^\d+\.\d{2}$/),
        transfer: {
          expectedReference: t.body.payment.nextAction.reference,
          bankName: 'Banco Pichincha',
          reference: 'TRX-889911',
          orderNumber: expect.stringMatching(/^\d+$/),
          voucherSubmittedAt: expect.any(String),
          verifiedAt: null,
          rejectionReason: null,
        },
      });
      expect(queue.body.every((p: { method: string; status: string }) => p.method === 'transfer' && p.status === 'pending')).toBe(true);
      const cards = await request(server()).get('/v1/payments?method=card').set('Authorization', reader).expect(200);
      expect(cards.body.every((p: { method: string; transfer: unknown }) => p.method === 'card' && p.transfer === null)).toBe(true);
      await request(server()).get('/v1/payments?method=bitcoin').set('Authorization', reader).expect(400);
      const detail = await request(server()).get(`/v1/payments/${t.paymentId}`).set('Authorization', reader).expect(200);
      expect(detail.body.bankTransfer).toMatchObject({ bankName: 'Banco Pichincha', reference: 'TRX-889911', verifiedAt: null });
      const voucher = await request(server()).get(`/v1/payments/${t.paymentId}/transfer/voucher`).set('Authorization', reader).expect(200);
      expect(voucher.headers['content-type']).toBe('application/pdf');
      expect(Buffer.from(voucher.body).equals(PDF)).toBe(true);

      await request(server()).post(`/v1/payments/${t.paymentId}/transfer/approve`).set('Authorization', reader).expect(403);
      const approved = await request(server()).post(`/v1/payments/${t.paymentId}/transfer/approve`).set('Authorization', verifier).expect(200);
      expect(approved.body).toMatchObject({ status: 'captured', bankTransfer: { verifiedBy: shop.userId } });
      expect(approved.body.events.map((e: { eventType: string }) => e.eventType)).toEqual(['created', 'voucher_submitted', 'captured']);

      await relay.drain({ tenantId: shop.tenantId });
      expect(await orderRow(db, t.orderId)).toMatchObject({ status: 'paid', payment_status: 'paid' });
      expect((await reservations(db, t.orderId))[0].status).toBe('consumed');
    });

    it('rechazar la transferencia → PaymentFailed, pedido cancelado y stock liberado', async () => {
      await relay.drain({ tenantId: shop.tenantId });
      const before = await stockQty(db, shop.blusa, shop.warehouseId);
      const t = await transferCheckout(1);
      await uploadVoucher(t.paymentId, t.secret).expect(200);
      await request(server()).post(`/v1/payments/${t.paymentId}/transfer/reject`).set('Authorization', verifier).send({ reason: 'El monto no coincide' }).expect(200);
      expect(await paymentRow(db, t.paymentId)).toMatchObject({ status: 'failed', failure_code: 'TRANSFER_REJECTED' });
      await relay.drain({ tenantId: shop.tenantId });
      expect(await orderRow(db, t.orderId)).toMatchObject({ status: 'cancelled', cancel_reason: 'Pago rechazado: El monto no coincide' });
      expect(await stockQty(db, shop.blusa, shop.warehouseId)).toEqual(before);
    });

    it('aprobar sin comprobante → 409 VOUCHER_NOT_SUBMITTED', async () => {
      const t = await transferCheckout();
      const res = await request(server()).post(`/v1/payments/${t.paymentId}/transfer/approve`).set('Authorization', verifier).expect(409);
      expect(res.body.error.code).toBe('VOUCHER_NOT_SUBMITTED');
    });
  });

  describe('vencimiento de pagos pendientes', () => {
    it('un pago con el plazo vencido pasa a expired, se cancela el pedido y se libera el stock', async () => {
      await relay.drain({ tenantId: shop.tenantId });
      const before = await stockQty(db, shop.blusa, shop.warehouseId);
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 2 }]);
      const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie })).expect(201);
      const orderId = res.body.orderId;
      const paymentId = res.body.payment.payment.id;
      expect(await getStock(db, shop.blusa, shop.warehouseId)).toMatchObject({ reserved: before.reserved + 2 });

      const payments = app.get(PaymentService);
      await payments.expirePending();
      expect(await paymentRow(db, paymentId)).toMatchObject({ status: 'pending' }); // todavía no venció

      await db.query(`UPDATE payments.payments SET expires_at = now() - interval '1 second' WHERE id = $1`, [paymentId]);
      expect((await payments.expirePending()).expired).toBeGreaterThanOrEqual(1);
      expect(await paymentRow(db, paymentId)).toMatchObject({ status: 'expired' });
      expect((await outboxEvents(db, shop.tenantId, 'PaymentExpired')).map((e) => e.aggregate_id)).toContain(paymentId);

      await relay.drain({ tenantId: shop.tenantId });
      expect(await orderRow(db, orderId)).toMatchObject({ status: 'cancelled', payment_status: 'failed', cancel_reason: 'Pago no completado a tiempo' });
      expect((await reservations(db, orderId))[0].status).toBe('released');
      expect(await stockQty(db, shop.blusa, shop.warehouseId)).toEqual(before);

      // La aprobación que llega tarde (el cliente pagó en el último segundo) no captura: queda
      // registrada para reembolso manual.
      const late = await postWebhook(app, paysimEvent({ type: 'payment.approved', reference: referenceFrom(res.body.payment.nextAction.url), amount: res.body.totals.total })).expect(200);
      expect(late.body).toMatchObject({ outcome: 'ignored', reason: 'PAYMENT_NOT_OPEN:expired' });
      const events = await db.query(`SELECT event_type FROM payments.payment_events WHERE payment_id = $1 ORDER BY id`, [paymentId]);
      expect(events.rows.map((r) => r.event_type)).toEqual(['created', 'expired', 'late_approval']);
    });

    it('un pago contra entrega (sin plazo) nunca vence', async () => {
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
      const cod = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie }, { paymentMethod: 'cod' })).expect(201);
      await app.get(PaymentService).expirePending();
      expect(await paymentRow(db, cod.body.payment.payment.id)).toMatchObject({ status: 'pending', expires_at: null });
    });
  });
});
