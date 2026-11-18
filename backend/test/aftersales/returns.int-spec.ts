import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
// Internos: el test maneja el mailer en memoria y el job de Facturación directamente.
import { StoreCreditMailer } from '../../libs/modules/aftersales/application/ports';
import { InMemoryStoreCreditMailer } from '../../libs/modules/aftersales/infrastructure/store-credit-mailer';
import { DocumentProcessor } from '../../libs/modules/billing/application/document-processor.service';
import { DocumentStorage, InvoiceMailer } from '../../libs/modules/billing/application/ports';
import { InMemoryInvoiceMailer } from '../../libs/modules/billing/infrastructure/mail/invoice-mailer';
import { OrdersApi } from '../../libs/modules/orders';
import { PromotionsApi } from '../../libs/modules/promotions';
import { Database, OutboxRelay, signAccessToken } from '../../libs/shared-kernel';
import { fakeSri, sri } from '../support/fake-sri';
import {
  createEmissionPoint,
  createStaff,
  customerTokenFor,
  getStock,
  ORDER_PERMISSIONS,
  outboxEvents,
  REFUND_PERMISSIONS,
  RETURN_PERMISSIONS,
  setStock,
} from '../support/fixtures';
import { createShop, customerCart, deliveryBody, guestCart, paysimEvent, postCheckout, postWebhook, referenceFrom, Shop } from '../support/shop';
import { createTestApp } from '../support/test-app';

// ------------------------------------------------------------------ pasarela falsa (reversos)

const gateway = {
  mode: 'ok' as 'ok' | 'reject' | 'down',
  calls: [] as { refundId: string; reference: string; amount: string; signature: string | undefined }[],
};

function fakeGateway(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const reply = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (req.method !== 'POST' || req.url !== '/refunds') return reply(404, {});
      const b = JSON.parse(body);
      gateway.calls.push({ refundId: b.refundId, reference: b.reference, amount: b.amount, signature: req.headers['x-paysim-signature'] as string });
      if (gateway.mode === 'down') return reply(503, {});
      if (gateway.mode === 'reject') return reply(422, { error: { code: 'REFUND_EXCEEDS_PAYMENT', message: 'El reverso supera lo cobrado' } });
      return reply(201, { id: `rf_${b.refundId.replace(/-/g, '')}`, status: 'succeeded', reference: b.reference, amount: b.amount });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ------------------------------------------------------------------ tests

/**
 * Devoluciones y cambios de punta a punta (HTTP + PostgreSQL): pedido real por checkout, solicitud
 * del cliente, aprobación con retiro de Logística, recepción e inspección en bodega (stock), reembolso
 * con Pagos (pasarela, gift card o transferencia; doble aprobación sobre $100) y nota de crédito del
 * SRI vinculada a la factura. Blusa 20.00 + IVA 15 % = 23.00; bolso 30.00 IVA 0 %; envío 3.00.
 */
describe('Devoluciones y cambios', () => {
  let app: INestApplication;
  let db: Database;
  let relay: OutboxRelay;
  let orders: OrdersApi;
  let promotions: PromotionsApi;
  let processor: DocumentProcessor;
  let invoiceMailer: InMemoryInvoiceMailer;
  let storeCreditMailer: InMemoryStoreCreditMailer;
  let storage: DocumentStorage;
  let sriServer: http.Server;
  let gatewayServer: http.Server;
  let shop: Shop;
  /** Talla L del mismo producto que la blusa (M). */
  let blusaL: string;
  let inspector: string;
  let approverA: string;
  let approverB: string;
  let customer: string;

  const server = () => app.getHttpServer();
  const staffToken = (userId: string, permissions: string[]) =>
    `Bearer ${signAccessToken({ id: userId, tenantId: shop.tenantId, type: 'staff', permissions }, process.env.JWT_SECRET!)}`;
  const staff = (userId = inspector) => staffToken(userId, [...RETURN_PERMISSIONS, ...REFUND_PERMISSIONS, ...ORDER_PERMISSIONS]);
  const drain = () => relay.drain({ tenantId: shop.tenantId });

  beforeAll(async () => {
    sriServer = await fakeSri();
    gatewayServer = await fakeGateway();
    process.env.SRI_URL = `http://127.0.0.1:${(sriServer.address() as AddressInfo).port}`;
    process.env.PAYSIM_API_URL = `http://127.0.0.1:${(gatewayServer.address() as AddressInfo).port}`;
    ({ app, db, relay } = await createTestApp({ withConsumers: true, withBilling: true }));
    orders = app.get(OrdersApi);
    promotions = app.get(PromotionsApi);
    processor = app.get(DocumentProcessor);
    invoiceMailer = app.get(InvoiceMailer) as InMemoryInvoiceMailer;
    storeCreditMailer = app.get(StoreCreditMailer) as InMemoryStoreCreditMailer;
    storage = app.get(DocumentStorage);

    shop = await createShop(db, { blusa: 50, bolso: 20 });
    await createEmissionPoint(db, shop.tenantId);
    const { rows } = await db.query<{ product_id: string }>(`SELECT product_id FROM catalog.product_variants WHERE id = $1`, [shop.blusa]);
    const l = await db.query<{ id: string }>(`INSERT INTO catalog.product_variants (product_id, sku) VALUES ($1, $2) RETURNING id`, [
      rows[0].product_id,
      `BLU-L-${randomUUID().slice(0, 6)}`,
    ]);
    blusaL = l.rows[0].id;
    await setStock(db, blusaL, shop.warehouseId, 2);
    inspector = shop.userId;
    approverA = await createStaff(db, shop.tenantId);
    approverB = await createStaff(db, shop.tenantId);
    customer = `Bearer ${customerTokenFor(shop.tenantId, shop.customerId)}`;
    Object.assign(sri, { reception: 'ok', pendingPolls: 0, authorization: 'ok' });
  });

  beforeEach(() => {
    gateway.mode = 'ok';
  });

  afterAll(async () => {
    await app.close();
    for (const s of [sriServer, gatewayServer]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  });

  /** Pedido del cliente por checkout, pagado (webhook de la pasarela o contra entrega) y entregado. */
  async function deliveredOrder(items: { variantId: string; quantity: number }[], paymentMethod: 'card' | 'cod' = 'card') {
    const bearer = await customerCart(app, shop, items);
    const res = await postCheckout(app, shop.tenantId, { bearer }, await deliveryBody(app, shop.tenantId, { bearer }, { paymentMethod })).expect(201);
    const orderId: string = res.body.orderId;
    let reference: string | null = null;
    if (paymentMethod === 'card') {
      reference = referenceFrom(res.body.payment.nextAction.url);
      await postWebhook(app, paysimEvent({ type: 'payment.approved', reference, amount: res.body.totals.total })).expect(200);
    }
    await drain();
    const actor = { type: 'staff' as const, id: inspector };
    for (const to of ['preparing', 'shipped', 'in_transit', 'delivered'] as const) await orders.changeStatus(shop.tenantId, orderId, to, actor);
    await drain();
    return { orderId, orderNumber: String(res.body.orderNumber), total: res.body.totals.total as string, reference, paymentId: res.body.payment.payment.id as string };
  }

  /** Pasa el job de Facturación (solo este tenant) hasta que no quede trabajo. */
  async function processBilling() {
    for (let i = 0; i < 10; i++) {
      await db.query(
        `UPDATE billing.electronic_documents SET next_retry_at = now() - interval '1 second'
          WHERE tenant_id = $1 AND next_retry_at IS NOT NULL`,
        [shop.tenantId],
      );
      if ((await processor.processDue(new Date(Date.now() + 3_600_000), 20, shop.tenantId)) === 0) return;
    }
  }

  async function itemsOf(orderId: string) {
    return (await orders.getOrder(shop.tenantId, orderId)).items;
  }

  function requestReturn(orderId: string, body: Record<string, unknown>, token = customer) {
    return request(server()).post(`/v1/me/orders/${orderId}/returns`).set('Authorization', token).send(body);
  }

  const post = (path: string, body: Record<string, unknown> = {}, token = staff()) =>
    request(server()).post(`/v1${path}`).set('Authorization', token).send(body);

  /** Solicitud → aprobación (retiro) → recepción → inspección, por HTTP. */
  async function throughInspection(returnId: string, inspection: { condition: string; restock: boolean } = { condition: 'new', restock: true }) {
    await post(`/returns/${returnId}/approve`).expect(200);
    await post(`/returns/${returnId}/receive`).expect(200);
    const detail = (await request(server()).get(`/v1/returns/${returnId}`).set('Authorization', staff()).expect(200)).body;
    const items = detail.lines.map((l: { returnItemId: string }) => ({ returnItemId: l.returnItemId, ...inspection }));
    return (await post(`/returns/${returnId}/inspect`, { items }).expect(200)).body;
  }

  describe('devolución con reembolso a la tarjeta (una aprobación) y nota de crédito', () => {
    let order: Awaited<ReturnType<typeof deliveredOrder>>;
    let returnId: string;

    beforeAll(async () => {
      order = await deliveredOrder([
        { variantId: shop.blusa, quantity: 2 },
        { variantId: shop.bolso, quantity: 1 },
      ]);
      await processBilling(); // la factura queda autorizada
    });

    it('el cliente sube la foto y solicita la devolución con motivo', async () => {
      const photo = await request(server())
        .post('/v1/me/returns/photos')
        .set('Authorization', customer)
        .attach('photo', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { filename: 'mancha.jpg', contentType: 'image/jpeg' })
        .expect(201);
      expect(photo.body.key).toMatch(new RegExp(`^returns/photos/${shop.tenantId}/${shop.customerId}/.+\\.jpg$`));

      const blusa = (await itemsOf(order.orderId)).find((i) => i.variantId === shop.blusa)!;
      // Una clave que no es de POST /me/returns/photos (otro prefijo, ../): 400 por formato.
      for (const bad of [`payments/vouchers/${shop.tenantId}/x.pdf`, `returns/photos/${shop.tenantId}/${shop.customerId}/../../a.jpg`]) {
        await requestReturn(order.orderId, { type: 'return', items: [{ orderItemId: blusa.id, quantity: 1, reasonCode: 'defect', photos: [bad] }] }).expect(400);
      }
      // Defecto sin foto: 422.
      const noPhoto = await requestReturn(order.orderId, { type: 'return', items: [{ orderItemId: blusa.id, quantity: 1, reasonCode: 'defect' }] });
      expect(noPhoto.status).toBe(422);
      expect(noPhoto.body.error.code).toBe('PHOTO_REQUIRED');

      const res = await requestReturn(order.orderId, {
        type: 'return',
        customerNotes: 'Tiene una mancha en la manga',
        items: [{ orderItemId: blusa.id, quantity: 1, reasonCode: 'defect', photos: [photo.body.key] }],
      }).expect(201);
      returnId = res.body.id;
      expect(res.body).toMatchObject({
        status: 'requested',
        type: 'return',
        resolution: 'refund_original',
        rmaNumber: `RMA-${order.orderNumber}-1`,
        reason: 'Producto defectuoso',
        returnShippingPaidBy: 'store',
        lines: [{ sku: expect.any(String), quantity: 1, taxBase: '20.00', taxAmount: '3.00', total: '23.00', photos: [photo.body.key] }],
      });
      expect((await outboxEvents(db, shop.tenantId, 'ReturnRequested')).map((e) => e.aggregate_id)).toContain(returnId);

      // El backoffice ve la foto.
      const img = await request(server())
        .get(`/v1/returns/${returnId}/items/${res.body.lines[0].returnItemId}/photos/0`)
        .set('Authorization', staff())
        .expect(200);
      expect(img.headers['content-type']).toBe('image/jpeg');
      // Índice fuera de 0..MAX_PHOTOS_PER_ITEM-1: 400 sin tocar el almacén.
      const photoUrl = (i: number) => `/v1/returns/${returnId}/items/${res.body.lines[0].returnItemId}/photos/${i}`;
      await request(server()).get(photoUrl(5)).set('Authorization', staff()).expect(400);
      await request(server()).get(photoUrl(-1)).set('Authorization', staff()).expect(400);
    });

    it('aprobar crea el retiro en Logística (direction return) y recibir lo marca entregado', async () => {
      const approved = (await post(`/returns/${returnId}/approve`).expect(200)).body;
      expect(approved).toMatchObject({
        status: 'pickup_scheduled',
        approvedBy: inspector,
        pickupShipment: { direction: 'return', carrierType: 'rider', status: 'pending', originWarehouseId: shop.warehouseId, returnId },
      });
      const { rows: items } = await db.query(`SELECT quantity FROM logistics.shipment_items WHERE shipment_id = $1`, [approved.pickupShipment.id]);
      expect(items).toEqual([{ quantity: 1 }]);
      // Aprobar otra vez no crea otro retiro.
      expect((await post(`/returns/${returnId}/approve`).expect(409)).body.error.code).toBe('INVALID_RETURN_TRANSITION');

      const received = (await post(`/returns/${returnId}/receive`).expect(200)).body;
      expect(received).toMatchObject({ status: 'received', pickupShipment: { status: 'delivered' } });
    });

    it('la inspección reingresa el stock, deja el pedido parcialmente devuelto y solicita el reembolso', async () => {
      const before = await getStock(db, shop.blusa, shop.warehouseId);
      const detail = (await request(server()).get(`/v1/returns/${returnId}`).set('Authorization', staff()).expect(200)).body;
      const inspected = (
        await post(`/returns/${returnId}/inspect`, { items: [{ returnItemId: detail.lines[0].returnItemId, condition: 'new', restock: true }] }).expect(200)
      ).body;
      expect(inspected).toMatchObject({
        exchangePending: false,
        return: {
          status: 'inspected',
          refundAmount: '23.00',
          order: { status: 'partially_returned' },
          refund: { status: 'pending', amount: '23.00', method: 'original', requiredApprovals: 1, requestedBy: inspector, returnId },
        },
      });
      expect((await getStock(db, shop.blusa, shop.warehouseId)).on_hand).toBe(before.on_hand + 1);
      const { rows: movements } = await db.query(
        `SELECT quantity, movement_type, user_id FROM inventory.stock_movements WHERE reference_type = 'return' AND reference_id = $1`,
        [returnId],
      );
      expect(movements).toEqual([{ quantity: 1, movement_type: 'return', user_id: inspector }]);
      const { rows: oi } = await db.query(`SELECT qty_returned FROM sales.order_items WHERE order_id = $1 AND variant_id = $2`, [order.orderId, shop.blusa]);
      expect(oi[0].qty_returned).toBe(1);
    });

    it('quien inspeccionó no aprueba; otra persona aprueba y la pasarela reversa el cobro', async () => {
      const refundId = (await request(server()).get(`/v1/returns/${returnId}`).set('Authorization', staff()).expect(200)).body.refund.id;
      const self = await post(`/refunds/${refundId}/approve`, {}, staff(inspector)).expect(409);
      expect(self.body.error.code).toBe('REFUND_SELF_APPROVAL');

      const approved = (await post(`/refunds/${refundId}/approve`, {}, staff(approverA)).expect(200)).body;
      expect(approved).toMatchObject({ status: 'succeeded', approvedBy: approverA, plan: { external: { kind: 'gateway', amount: '23.00' } } });
      expect(approved.providerRef).toMatch(/^rf_/);
      expect(gateway.calls.at(-1)).toMatchObject({ refundId, reference: order.reference, amount: '23.00' });
      expect(gateway.calls.at(-1)!.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      const { rows } = await db.query(`SELECT status FROM payments.payments WHERE id = $1`, [order.paymentId]);
      expect(rows[0].status).toBe('partially_refunded');
    });

    it('RefundSucceeded: la devolución queda refunded, el pedido partially_refunded y sale la nota de crédito', async () => {
      await drain();
      const detail = (await request(server()).get(`/v1/returns/${returnId}`).set('Authorization', staff()).expect(200)).body;
      expect(detail).toMatchObject({ status: 'refunded', closedAt: expect.any(String) });
      const { rows: o } = await db.query(`SELECT status, payment_status FROM sales.orders WHERE id = $1`, [order.orderId]);
      expect(o[0]).toEqual({ status: 'partially_returned', payment_status: 'partially_refunded' });

      const { rows: docs } = await db.query(
        `SELECT id, doc_type, status, total, return_id, modified_document_id, sequential FROM billing.electronic_documents WHERE order_id = $1 ORDER BY created_at`,
        [order.orderId],
      );
      expect(docs).toHaveLength(2);
      const [invoice, creditNote] = docs;
      expect(invoice).toMatchObject({ doc_type: '01', status: 'authorized' });
      expect(creditNote).toMatchObject({ doc_type: '04', status: 'pending', total: '23.00', return_id: returnId, modified_document_id: invoice.id });

      invoiceMailer.sent.length = 0;
      await processBilling();
      const { rows: after } = await db.query(`SELECT status, xml_key, emailed_at FROM billing.electronic_documents WHERE id = $1`, [creditNote.id]);
      expect(after[0].status).toBe('authorized');
      const xml = (await storage.get(after[0].xml_key))!.content.toString('utf8');
      expect(xml).toContain('<codDoc>04</codDoc>');
      expect(xml).toContain('<codDocModificado>01</codDocModificado>');
      expect(xml).toContain(`<numDocModificado>001-001-${String(invoice.sequential).padStart(9, '0')}</numDocModificado>`);
      expect(xml).toContain('<valorModificacion>23.00</valorModificacion>');
      expect(xml).toContain(`<motivo>Devolución RMA-${order.orderNumber}-1: Producto defectuoso</motivo>`);
      const mail = invoiceMailer.sent.find((m) => m.subject.startsWith('Nota de crédito'));
      expect(mail?.attachments.map((a) => a.filename)).toEqual([expect.stringMatching(/^nota-credito-001-001-\d{9}\.pdf$/), expect.stringMatching(/\.xml$/)]);

      // Otra entrega de RefundSucceeded no emite otra nota de crédito.
      const again = await request(server()).get(`/v1/billing/documents?returnId=${returnId}`).set('Authorization', staffToken(inspector, ['billing.read'])).expect(200);
      expect(again.body).toHaveLength(1);
    });
  });

  describe('saldo a favor por encima de $100: doble aprobación y gift card nueva', () => {
    it('dos personas distintas aprueban; la gift card llega por email y el pedido queda devuelto', async () => {
      const order = await deliveredOrder([{ variantId: shop.blusa, quantity: 5 }]); // 5 × 23.00 + 3.00 = 118.00
      const [line] = await itemsOf(order.orderId);
      const created = (
        await requestReturn(order.orderId, {
          type: 'return',
          resolution: 'store_credit',
          items: [{ orderItemId: line.id, quantity: 5, reasonCode: 'changed_mind' }],
        }).expect(201)
      ).body;
      const inspected = await throughInspection(created.id);
      expect(inspected.return).toMatchObject({ refundAmount: '115.00', order: { status: 'returned' } });
      const refund = inspected.return.refund;
      expect(refund).toMatchObject({ amount: '115.00', method: 'gift_card', requiredApprovals: 2, status: 'pending' });

      const first = (await post(`/refunds/${refund.id}/approve`, {}, staff(approverA)).expect(200)).body;
      expect(first).toMatchObject({ status: 'pending', approvedBy: null, approvals: [{ userId: approverA }] });
      const same = await post(`/refunds/${refund.id}/approve`, {}, staff(approverA)).expect(409);
      expect(same.body.error.code).toBe('REFUND_SECOND_APPROVER_REQUIRED');

      storeCreditMailer.sent.length = 0;
      const second = (await post(`/refunds/${refund.id}/approve`, {}, staff(approverB)).expect(200)).body;
      expect(second).toMatchObject({ status: 'succeeded', approvedBy: approverB, plan: { external: null, storeCredit: '115.00' } });
      expect(second.approvals.map((a: { userId: string }) => a.userId)).toEqual([approverA, approverB]);
      expect(gateway.calls.some((c) => c.refundId === refund.id)).toBe(false);

      const [mail] = storeCreditMailer.sent;
      expect(mail).toMatchObject({ to: 'ana@example.test', amount: '115.00', rmaNumber: created.rmaNumber });
      expect(await promotions.getGiftCardBalance(shop.tenantId, mail.code)).toMatchObject({ balance: '115.00', status: 'active', last4: mail.last4 });

      await drain();
      const { rows } = await db.query(`SELECT status, payment_status FROM sales.orders WHERE id = $1`, [order.orderId]);
      expect(rows[0]).toEqual({ status: 'returned', payment_status: 'refunded' });
    });

    it('si el SMTP falla, no se emite la gift card (el código no se pierde) y se puede reintentar', async () => {
      const order = await deliveredOrder([{ variantId: shop.blusa, quantity: 1 }]);
      const [line] = await itemsOf(order.orderId);
      const created = (
        await requestReturn(order.orderId, { type: 'return', resolution: 'store_credit', items: [{ orderItemId: line.id, quantity: 1, reasonCode: 'size_large' }] }).expect(201)
      ).body;
      const refund = (await throughInspection(created.id)).return.refund;
      const cards = async () => (await db.query(`SELECT count(*)::int AS n FROM sales.gift_cards WHERE tenant_id = $1`, [shop.tenantId])).rows[0].n;
      const before = await cards();
      storeCreditMailer.failNext = 1;
      await post(`/refunds/${refund.id}/approve`, {}, staff(approverA)).expect(500);
      expect(await cards()).toBe(before);
      expect((await request(server()).get(`/v1/refunds/${refund.id}`).set('Authorization', staff()).expect(200)).body.status).toBe('pending');
      expect((await post(`/refunds/${refund.id}/approve`, {}, staff(approverA)).expect(200)).body.status).toBe('succeeded');
      expect(await cards()).toBe(before + 1);
    });
  });

  describe('cambio de talla', () => {
    it('sin stock de la talla nueva: 409 al solicitar', async () => {
      const order = await deliveredOrder([{ variantId: shop.blusa, quantity: 3 }]);
      const [line] = await itemsOf(order.orderId);
      const res = await requestReturn(order.orderId, {
        type: 'exchange',
        items: [{ orderItemId: line.id, quantity: 3, reasonCode: 'size_small', exchangeVariantId: blusaL }],
      }).expect(409);
      expect(res.body.error.code).toBe('EXCHANGE_OUT_OF_STOCK');
      // Otro producto no es un cambio de talla.
      const other = await requestReturn(order.orderId, {
        type: 'exchange',
        items: [{ orderItemId: line.id, quantity: 1, reasonCode: 'size_small', exchangeVariantId: shop.bolso }],
      }).expect(422);
      expect(other.body.error.code).toBe('EXCHANGE_VARIANT_INVALID');
    });

    it('la inspección reingresa la talla devuelta, descuenta la nueva y crea el envío con la variante nueva', async () => {
      const order = await deliveredOrder([{ variantId: shop.blusa, quantity: 1 }]);
      const [line] = await itemsOf(order.orderId);
      const created = (
        await requestReturn(order.orderId, {
          type: 'exchange',
          items: [{ orderItemId: line.id, quantity: 1, reasonCode: 'size_small', exchangeVariantId: blusaL }],
        }).expect(201)
      ).body;
      expect(created).toMatchObject({ type: 'exchange', resolution: 'exchange' });
      const m = await getStock(db, shop.blusa, shop.warehouseId);
      const l = await getStock(db, blusaL, shop.warehouseId);

      const inspected = await throughInspection(created.id);
      expect(inspected).toMatchObject({
        exchangePending: false,
        return: {
          status: 'exchanged',
          refundAmount: null,
          refund: null,
          order: { status: 'delivered' },
          exchangeShipment: { direction: 'exchange', status: 'pending', originWarehouseId: shop.warehouseId, returnId: created.id },
        },
      });
      expect((await getStock(db, shop.blusa, shop.warehouseId)).on_hand).toBe(m.on_hand + 1);
      expect(await getStock(db, blusaL, shop.warehouseId)).toMatchObject({ on_hand: l.on_hand - 1, reserved: l.reserved });
      const { rows } = await db.query(
        `SELECT variant_id, quantity, movement_type FROM inventory.stock_movements WHERE reference_type = 'exchange' AND reference_id = $1`,
        [created.id],
      );
      expect(rows).toEqual([{ variant_id: blusaL, quantity: -1, movement_type: 'sale' }]);
      const { rows: docs } = await db.query(`SELECT doc_type FROM billing.electronic_documents WHERE return_id = $1`, [created.id]);
      expect(docs).toEqual([]); // un cambio no lleva nota de crédito
      expect((await outboxEvents(db, shop.tenantId, 'ReturnExchanged')).map((e) => e.aggregate_id)).toContain(created.id);
    });

    it('si el stock se agotó antes de inspeccionar, queda pendiente y se reintenta el envío', async () => {
      await setStock(db, blusaL, shop.warehouseId, 1);
      const order = await deliveredOrder([{ variantId: shop.blusa, quantity: 1 }]);
      const [line] = await itemsOf(order.orderId);
      const created = (
        await requestReturn(order.orderId, {
          type: 'exchange',
          items: [{ orderItemId: line.id, quantity: 1, reasonCode: 'size_small', exchangeVariantId: blusaL }],
        }).expect(201)
      ).body;
      await post(`/returns/${created.id}/approve`).expect(200);
      await setStock(db, blusaL, shop.warehouseId, 0);
      await post(`/returns/${created.id}/receive`).expect(200);
      const detail = (await request(server()).get(`/v1/returns/${created.id}`).set('Authorization', staff()).expect(200)).body;
      const inspected = (
        await post(`/returns/${created.id}/inspect`, { items: [{ returnItemId: detail.lines[0].returnItemId, condition: 'used', restock: false }] }).expect(200)
      ).body;
      expect(inspected).toMatchObject({ exchangePending: true, return: { status: 'inspected', exchangeShipment: null } });

      expect((await post(`/returns/${created.id}/exchange-shipment`).expect(409)).body.error.code).toBe('INSUFFICIENT_STOCK');
      await setStock(db, blusaL, shop.warehouseId, 4);
      const retried = (await post(`/returns/${created.id}/exchange-shipment`).expect(200)).body;
      expect(retried).toMatchObject({ status: 'exchanged', exchangeShipment: { direction: 'exchange' } });
      expect((await getStock(db, blusaL, shop.warehouseId)).on_hand).toBe(3);
    });
  });

  describe('contra entrega: reembolso por transferencia', () => {
    it('una aprobación y finanzas registra la transferencia', async () => {
      const order = await deliveredOrder([{ variantId: shop.bolso, quantity: 1 }], 'cod');
      const { rows: pay } = await db.query(`SELECT status, method FROM payments.payments WHERE order_id = $1`, [order.orderId]);
      expect(pay[0]).toEqual({ status: 'captured', method: 'cod' });
      const [line] = await itemsOf(order.orderId);
      const created = (await requestReturn(order.orderId, { type: 'return', items: [{ orderItemId: line.id, quantity: 1, reasonCode: 'changed_mind' }] }).expect(201)).body;
      const refund = (await throughInspection(created.id)).return.refund;
      expect(refund).toMatchObject({ amount: '30.00', method: 'transfer', requiredApprovals: 1 });

      const approved = (await post(`/refunds/${refund.id}/approve`, {}, staff(approverB)).expect(200)).body;
      expect(approved).toMatchObject({ status: 'processing', pendingParts: ['external'], plan: { external: { kind: 'transfer', amount: '30.00' } } });
      const done = (
        await post(`/refunds/${refund.id}/transfer/complete`, { bankName: 'Banco Pichincha', reference: 'TRX-778899' }, staff(approverA)).expect(200)
      ).body;
      expect(done).toMatchObject({ status: 'succeeded', providerRef: 'Banco Pichincha TRX-778899' });
      await drain();
      const { rows } = await db.query(`SELECT status FROM sales.returns WHERE id = $1`, [created.id]);
      expect(rows[0].status).toBe('refunded');
    });
  });

  describe('reglas y permisos', () => {
    it('un pedido ajeno responde 404; cantidades y estados se validan', async () => {
      const order = await deliveredOrder([{ variantId: shop.blusa, quantity: 1 }]);
      const [line] = await itemsOf(order.orderId);
      const other = `Bearer ${customerTokenFor(shop.tenantId, randomUUID())}`;
      await requestReturn(order.orderId, { type: 'return', items: [{ orderItemId: line.id, quantity: 1, reasonCode: 'other' }] }, other).expect(404);

      const tooMany = await requestReturn(order.orderId, { type: 'return', items: [{ orderItemId: line.id, quantity: 2, reasonCode: 'other' }] }).expect(422);
      expect(tooMany.body.error.code).toBe('RETURN_QUANTITY_EXCEEDED');

      const first = await requestReturn(order.orderId, { type: 'return', items: [{ orderItemId: line.id, quantity: 1, reasonCode: 'other' }] }).expect(201);
      // La unidad ya está en una solicitud abierta.
      const again = await requestReturn(order.orderId, { type: 'return', items: [{ orderItemId: line.id, quantity: 1, reasonCode: 'other' }] }).expect(422);
      expect(again.body.error.code).toBe('RETURN_QUANTITY_EXCEEDED');

      // Rechazo: libera las unidades para una nueva solicitud.
      const rejected = (await post(`/returns/${first.body.id}/reject`, { reason: 'Fuera de la política de devoluciones' }).expect(200)).body;
      expect(rejected).toMatchObject({ status: 'rejected', closedAt: expect.any(String) });
      const [ev] = (await outboxEvents(db, shop.tenantId, 'ReturnRejected')).filter((e) => e.aggregate_id === first.body.id);
      expect(ev.payload).toMatchObject({ rejectionReason: 'Fuera de la política de devoluciones' });
      await requestReturn(order.orderId, { type: 'return', items: [{ orderItemId: line.id, quantity: 1, reasonCode: 'other' }] }).expect(201);

      // Mis devoluciones: solo las propias.
      const mine = (await request(server()).get('/v1/me/returns').set('Authorization', customer).expect(200)).body;
      expect(mine.length).toBeGreaterThanOrEqual(2);
      await request(server()).get(`/v1/me/returns/${first.body.id}`).set('Authorization', other).expect(404);
    });

    it('fuera del plazo de devolución: 409', async () => {
      const order = await deliveredOrder([{ variantId: shop.blusa, quantity: 1 }]);
      await db.query(`UPDATE sales.orders SET delivered_at = now() - interval '31 days' WHERE id = $1`, [order.orderId]);
      const [line] = await itemsOf(order.orderId);
      const res = await requestReturn(order.orderId, { type: 'return', items: [{ orderItemId: line.id, quantity: 1, reasonCode: 'other' }] }).expect(409);
      expect(res.body.error.code).toBe('RETURN_WINDOW_EXPIRED');
    });

    it('sin permisos no se aprueba; el estado returned no se fija a mano', async () => {
      const order = await deliveredOrder([{ variantId: shop.blusa, quantity: 1 }]);
      const [line] = await itemsOf(order.orderId);
      const created = (await requestReturn(order.orderId, { type: 'return', items: [{ orderItemId: line.id, quantity: 1, reasonCode: 'other' }] }).expect(201)).body;
      await post(`/returns/${created.id}/approve`, {}, staffToken(inspector, ['returns.read'])).expect(403);
      await post(`/returns/${created.id}/approve`, {}, customer).expect(403);
      // Las devoluciones las registra el flujo (qty_returned, reembolso): el DTO no admite el estado.
      const manual = await post(`/orders/${order.orderId}/status`, { to: 'returned', version: 5, reason: 'x' }).expect(400);
      expect(JSON.stringify(manual.body)).toContain('to must be one of the following values');
    });
  });

  describe('soporte registra la devolución de un pedido de invitado', () => {
    it('crea la solicitud sin cuenta del cliente y sigue el flujo normal hasta el reembolso', async () => {
      const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
      const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie })).expect(201);
      const orderId: string = res.body.orderId;
      await postWebhook(app, paysimEvent({ type: 'payment.approved', reference: referenceFrom(res.body.payment.nextAction.url), amount: res.body.totals.total })).expect(200);
      await drain();
      for (const to of ['preparing', 'shipped', 'in_transit', 'delivered'] as const) await orders.changeStatus(shop.tenantId, orderId, to, { type: 'staff', id: inspector });
      await drain();
      const [line] = await itemsOf(orderId);
      const body = { orderId, type: 'return', resolution: 'refund_original', reason: 'Llamó a soporte', items: [{ orderItemId: line.id, quantity: 1, reasonCode: 'size_small' }] };

      // El cliente no usa esta ruta; sin returns.approve tampoco.
      await post('/returns', body, customer).expect(403);
      await post('/returns', body, staffToken(inspector, ['returns.read'])).expect(403);
      // Las fotos son del cliente: soporte no las adjunta.
      const withPhoto = { ...body, items: [{ ...body.items[0], photos: [`returns/photos/${shop.tenantId}/${shop.customerId}/${randomUUID()}.jpg`] }] };
      expect((await post('/returns', withPhoto).expect(422)).body.error.code).toBe('INVALID_PHOTO');

      const created = (await post('/returns', body).expect(201)).body;
      expect(created).toMatchObject({ orderId, status: 'requested', type: 'return' });
      const inspected = await throughInspection(created.id);
      expect(inspected.return.refund).toMatchObject({ amount: expect.any(String) });
    });
  });
});
