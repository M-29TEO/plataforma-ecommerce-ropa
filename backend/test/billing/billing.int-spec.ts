import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BillingApi } from '../../libs/modules/billing';
// Internos de Facturación: el test maneja el job y los adaptadores en memoria directamente.
import { DocumentProcessor } from '../../libs/modules/billing/application/document-processor.service';
import { DocumentStorage, InvoiceMailer } from '../../libs/modules/billing/application/ports';
import { isValidAccessKey, parseAccessKey } from '../../libs/modules/billing/domain/access-key';
import { InMemoryInvoiceMailer } from '../../libs/modules/billing/infrastructure/mail/invoice-mailer';
import { NewOrder, OrdersApi } from '../../libs/modules/orders';
import { Database, OutboxRelay } from '../../libs/shared-kernel';
import {
  BILLING_PERMISSIONS,
  createCustomer,
  createEmissionPoint,
  createTenant,
  createVariants,
  createWarehouse,
  customerTokenFor,
  outboxEvents,
  TestTenant,
  tokenFor,
} from '../support/fixtures';
import { fakeSri, sri } from '../support/fake-sri';
import { createTestApp } from '../support/test-app';

// ------------------------------------------------------------------ tests

describe('Facturación electrónica SRI', () => {
  let app: INestApplication;
  let db: Database;
  let relay: OutboxRelay;
  let orders: OrdersApi;
  let billing: BillingApi;
  let processor: DocumentProcessor;
  let mailer: InMemoryInvoiceMailer;
  let storage: DocumentStorage;
  let server: http.Server;
  let t: TestTenant;
  let staff: string;
  let customerId: string;
  let warehouseId: string;
  let variants: string[];

  beforeAll(async () => {
    server = await fakeSri();
    process.env.SRI_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ app, db, relay } = await createTestApp({ withBilling: true }));
    orders = app.get(OrdersApi);
    billing = app.get(BillingApi);
    processor = app.get(DocumentProcessor);
    mailer = app.get(InvoiceMailer) as InMemoryInvoiceMailer;
    storage = app.get(DocumentStorage);
    t = await createTenant(db);
    staff = `Bearer ${tokenFor(t, BILLING_PERMISSIONS)}`;
    customerId = await createCustomer(db, t.tenantId);
    warehouseId = await createWarehouse(db, t.tenantId);
    variants = await createVariants(db, t.tenantId, 2);
    await createEmissionPoint(db, t.tenantId);
  });

  beforeEach(() => {
    Object.assign(sri, { reception: 'ok', pendingPolls: 1, authorization: 'ok', receptionCalls: 0 });
  });

  // Aislamiento: lo que un test deja pendiente no lo procesa el siguiente.
  afterEach(async () => {
    await db.query('UPDATE billing.electronic_documents SET next_retry_at = NULL WHERE next_retry_at IS NOT NULL AND tenant_id = $1', [t.tenantId]);
  });

  afterAll(async () => {
    await app.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const api = () => request(app.getHttpServer());

  function orderInput(overrides: Partial<NewOrder> = {}): NewOrder {
    return {
      id: randomUUID(),
      tenantId: t.tenantId,
      userId: customerId,
      customer: { name: 'Ana Pérez', email: 'ana@example.test', phone: '0991234567' },
      billing: { name: 'Ana Pérez', idType: '05', idNumber: '1710034065', email: 'ana@example.test' },
      paymentMethod: 'card',
      fulfillmentType: 'rider',
      shippingAddress: { mainStreet: 'Av. Amazonas', number: 'N34-45', city: 'Quito' },
      shippingLocation: { lat: -0.1807, lng: -78.4678 },
      shippingCity: 'Quito',
      sourceWarehouseId: warehouseId,
      shippingTotal: '3.00',
      items: [
        { variantId: variants[0], productId: randomUUID(), sku: 'BLU-LIN-M', productName: 'Blusa lino', colorName: 'Blanco', sizeCode: 'M', quantity: 2, unitPrice: '20.00', discount: '2.00', taxCode: '4', taxRate: '15.00', warehouseId },
        { variantId: variants[1], productId: randomUUID(), sku: 'BOL-CUE', productName: 'Bolso cuero', quantity: 1, unitPrice: '30.00', taxCode: '0', taxRate: '0.00', warehouseId },
      ],
      ...overrides,
    };
  }

  /** Pedido pagado + relay: el consumidor de OrderPaid crea la factura. */
  async function paidOrder(overrides: Partial<NewOrder> = {}) {
    const order = await orders.placeOrder(orderInput(overrides));
    await orders.markPaid(t.tenantId, order.id);
    await relay.drain({ tenantId: t.tenantId });
    return order;
  }

  async function docFor(orderId: string) {
    const { rows } = await db.query(
      `SELECT d.*, (SELECT count(*)::int FROM billing.electronic_document_lines l WHERE l.document_id = d.id) AS line_count
         FROM billing.electronic_documents d WHERE d.order_id = $1`,
      [orderId],
    );
    return rows;
  }

  const at = (seconds: number) => new Date(Date.now() + seconds * 1000);

  describe('emisión (consumidor de OrderPaid)', () => {
    it('crea la factura con secuencial, clave de acceso de 49 dígitos y líneas (ítems + envío)', async () => {
      const order = await paidOrder();
      const [doc] = await docFor(order.id);
      expect(doc).toMatchObject({
        doc_type: '01',
        status: 'pending',
        buyer_id_type: '05',
        buyer_id: '1710034065',
        buyer_name: 'Ana Pérez',
        buyer_email: 'ana@example.test',
        subtotal_0: '33.00',
        subtotal_taxed: '38.00',
        discount_total: '2.00',
        tax_total: '5.70',
        total: '76.70',
        line_count: 3,
      });
      expect(doc.payment_forms).toEqual([{ code: '19', total: '76.70' }]);
      expect(isValidAccessKey(doc.access_key)).toBe(true);
      const key = parseAccessKey(doc.access_key);
      expect(key).toMatchObject({ docType: '01', ruc: '1790000000001', environment: 1, establishment: '001', emissionPoint: '001', sequential: Number(doc.sequential) });
      expect(key.issueDate).toBe(doc.issue_date);
    });

    it('es idempotente: el mismo evento dos veces no duplica la factura ni gasta secuencial', async () => {
      const order = await paidOrder();
      const [first] = await docFor(order.id);
      const again = await billing.issueForOrder(t.tenantId, order.id);
      expect(again).toEqual({ documentId: first.id, created: false });
      await db.query(`UPDATE platform.outbox_events SET published_at = NULL WHERE aggregate_id = $1 AND event_type = 'OrderPaid'`, [order.id]);
      await relay.drain({ tenantId: t.tenantId });
      expect(await docFor(order.id)).toHaveLength(1);
      const { rows } = await db.query(
        `SELECT s.last_value, (SELECT max(sequential) FROM billing.electronic_documents d WHERE d.emission_point_id = s.emission_point_id) AS max
           FROM billing.sequences s JOIN billing.emission_points ep ON ep.id = s.emission_point_id WHERE ep.tenant_id = $1 AND s.doc_type = '01'`,
        [t.tenantId],
      );
      expect(rows[0].last_value).toBe(rows[0].max);
    });

    it('20 facturas concurrentes: secuenciales consecutivos, sin huecos ni duplicados (y el mismo pedido dos veces = una factura)', async () => {
      const placed = [];
      for (let i = 0; i < 20; i++) {
        const o = await orders.placeOrder(orderInput());
        await orders.markPaid(t.tenantId, o.id);
        placed.push(o.id);
      }
      const { rows: before } = await db.query(
        `SELECT s.last_value::int AS v FROM billing.sequences s JOIN billing.emission_points ep ON ep.id = s.emission_point_id WHERE ep.tenant_id = $1 AND s.doc_type = '01'`,
        [t.tenantId],
      );
      const results = await Promise.all([...placed, placed[0], placed[1]].map((id) => billing.issueForOrder(t.tenantId, id)));
      expect(results.filter((r) => r.created)).toHaveLength(20);

      const { rows } = await db.query<{ sequential: string }>(
        `SELECT sequential FROM billing.electronic_documents WHERE order_id = ANY($1::uuid[]) ORDER BY sequential`,
        [placed],
      );
      const seqs = rows.map((r) => Number(r.sequential));
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => before[0].v + 1 + i));
      const { rows: after } = await db.query(
        `SELECT s.last_value::int AS v FROM billing.sequences s JOIN billing.emission_points ep ON ep.id = s.emission_point_id WHERE ep.tenant_id = $1 AND s.doc_type = '01'`,
        [t.tenantId],
      );
      expect(after[0].v).toBe(before[0].v + 20);
      // Los OrderPaid de estos pedidos quedan en el outbox: al publicarse no crean otra factura.
      await relay.drain({ tenantId: t.tenantId });
      expect(Number((await db.query(`SELECT count(*) FROM billing.electronic_documents WHERE order_id = ANY($1::uuid[])`, [placed])).rows[0].count)).toBe(20);
    });

    it('sin identificación: CONSUMIDOR FINAL 07 / 9999999999999', async () => {
      const order = await paidOrder({ billing: { email: 'ana@example.test' } });
      const [doc] = await docFor(order.id);
      expect(doc).toMatchObject({ buyer_id_type: '07', buyer_id: '9999999999999', buyer_name: 'CONSUMIDOR FINAL', buyer_email: 'ana@example.test' });
    });

    it('contra entrega: se factura al entregar (OrderPaid en la entrega), con forma de pago 01', async () => {
      const order = await orders.placeOrder(orderInput({ paymentMethod: 'cod' }));
      for (const to of ['preparing', 'shipped', 'in_transit'] as const) await orders.changeStatus(t.tenantId, order.id, to);
      await relay.drain({ tenantId: t.tenantId });
      expect(await docFor(order.id)).toHaveLength(0);
      await orders.changeStatus(t.tenantId, order.id, 'delivered');
      await relay.drain({ tenantId: t.tenantId });
      const docs = await docFor(order.id);
      expect(docs).toHaveLength(1);
      expect(docs[0].payment_forms).toEqual([{ code: '01', total: '76.70' }]);
    });

    it('sin punto de emisión configurado, el evento falla y se reintenta (no se pierde la factura)', async () => {
      const other = await createTenant(db);
      const w = await createWarehouse(db, other.tenantId);
      const v = await createVariants(db, other.tenantId, 1);
      const o = await orders.placeOrder({
        ...orderInput(),
        tenantId: other.tenantId,
        userId: null,
        sourceWarehouseId: w,
        items: [{ variantId: v[0], productId: randomUUID(), sku: 'X-1', productName: 'X', quantity: 1, unitPrice: '10.00', taxCode: '4', taxRate: '15.00', warehouseId: w }],
      });
      await orders.markPaid(other.tenantId, o.id);
      const result = await relay.drain({ tenantId: other.tenantId });
      expect(result.failed).toBe(1);
      await createEmissionPoint(db, other.tenantId);
      await relay.drain({ tenantId: other.tenantId });
      expect(await docFor(o.id)).toHaveLength(1);
    });
  });

  describe('envío al SRI, autorización, RIDE y email', () => {
    it('pending → firmado → RECIBIDA → (en proceso) → AUTORIZADO: guarda XML y RIDE, envía el email y publica InvoiceAuthorized', async () => {
      const order = await paidOrder();
      const [created] = await docFor(order.id);

      await processor.processDue(at(1), 20, t.tenantId);
      let [doc] = await docFor(order.id);
      expect(doc.status).toBe('received');
      const signed = (await storage.get(doc.xml_key))!.content.toString('utf8');
      expect(signed.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<factura id="comprobante" version="2.1.0">')).toBe(true);
      expect(signed).toContain('<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"');
      expect(signed).toContain(`<claveAcceso>${created.access_key}</claveAcceso>`);
      expect(sri.received.get(created.access_key)!.xml).toBe(signed.replace(/^<\?xml[^>]*\?>\n/, ''));

      // Primera consulta: el SRI todavía procesa → se reintenta con backoff.
      await processor.processDue(at(10), 20, t.tenantId);
      [doc] = await docFor(order.id);
      expect(doc).toMatchObject({ status: 'received', attempts: 1 });

      await processor.processDue(at(60), 20, t.tenantId);
      [doc] = await docFor(order.id);
      expect(doc).toMatchObject({ status: 'authorized', authorization_number: created.access_key, attempts: 0, next_retry_at: null });
      expect(doc.authorized_at).toEqual(new Date('2026-09-30T15:21:04Z'));
      expect(doc.emailed_at).not.toBeNull();
      expect(doc.xml_key).toMatch(/autorizado\.xml$/);
      const authorized = (await storage.get(doc.xml_key))!.content.toString('utf8');
      expect(authorized).toContain('<estado>AUTORIZADO</estado>');
      expect(authorized).toContain('<comprobante><![CDATA[<factura id="comprobante"');
      const ride = (await storage.get(doc.ride_key))!;
      expect(ride.contentType).toBe('application/pdf');
      expect(ride.content.subarray(0, 8).toString()).toBe('%PDF-1.4');

      const mail = mailer.sent.find((m) => m.text.includes(created.access_key))!;
      expect(mail.to).toBe('ana@example.test');
      expect(mail.subject).toBe(`Factura electrónica 001-001-${String(created.sequential).padStart(9, '0')} - Moda Demo`);
      expect(mail.attachments.map((a) => a.contentType)).toEqual(['application/pdf', 'application/xml']);

      const events = await outboxEvents(db, t.tenantId, 'InvoiceAuthorized');
      expect(events.find((e) => e.aggregate_id === doc.id)?.payload).toMatchObject({ orderId: order.id, accessKey: created.access_key, total: '76.70' });
    });

    it('backoffice: lista, detalle, XML y RIDE (billing.read); el cliente descarga su factura y no la ajena', async () => {
      const order = await paidOrder();
      sri.pendingPolls = 0;
      await processor.processDue(at(1), 20, t.tenantId);
      await processor.processDue(at(10), 20, t.tenantId);
      const [doc] = await docFor(order.id);
      expect(doc.status).toBe('authorized');

      const list = await api().get(`/v1/billing/documents?orderId=${order.id}`).set('Authorization', staff).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ id: doc.id, status: 'authorized', number: `001-001-${String(doc.sequential).padStart(9, '0')}`, files: { xml: true, ride: true } });
      const detail = await api().get(`/v1/billing/documents/${doc.id}`).set('Authorization', staff).expect(200);
      expect(detail.body.lines).toHaveLength(3);
      const pdf = await api().get(`/v1/billing/documents/${doc.id}/ride.pdf`).set('Authorization', staff).buffer(true).expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      const xml = await api().get(`/v1/billing/documents/${doc.id}/xml`).set('Authorization', staff).expect(200);
      expect(xml.headers['content-type']).toContain('application/xml');
      await api().get(`/v1/billing/documents/${doc.id}`).set('Authorization', `Bearer ${tokenFor(t, [])}`).expect(403);

      const mine = `Bearer ${customerTokenFor(t.tenantId, customerId)}`;
      const invoice = await api().get(`/v1/me/orders/${order.id}/invoice`).set('Authorization', mine).expect(200);
      expect(invoice.body).toMatchObject({ accessKey: doc.access_key, status: 'authorized' });
      await api().get(`/v1/me/orders/${order.id}/invoice/ride.pdf`).set('Authorization', mine).expect(200);
      const stranger = `Bearer ${customerTokenFor(t.tenantId, await createCustomer(db, t.tenantId))}`;
      await api().get(`/v1/me/orders/${order.id}/invoice`).set('Authorization', stranger).expect(404);
    });

    it('DEVUELTA: queda returned con los mensajes del SRI, sin reintento, y publica InvoiceRejected', async () => {
      const order = await paidOrder();
      sri.reception = 'devuelta';
      await processor.processDue(at(1), 20, t.tenantId);
      const [doc] = await docFor(order.id);
      expect(doc).toMatchObject({ status: 'returned', next_retry_at: null });
      expect(doc.sri_messages).toEqual([
        { identificador: '35', mensaje: 'ARCHIVO NO CUMPLE ESTRUCTURA XML', informacionAdicional: 'Identificación del comprador inválida', tipo: 'ERROR' },
      ]);
      const events = await outboxEvents(db, t.tenantId, 'InvoiceRejected');
      expect(events.find((e) => e.aggregate_id === doc.id)?.payload).toMatchObject({ status: 'returned', orderId: order.id });
    });

    it('NO AUTORIZADO: queda not_authorized', async () => {
      const order = await paidOrder();
      Object.assign(sri, { pendingPolls: 0, authorization: 'no_autorizado' });
      await processor.processDue(at(1), 20, t.tenantId);
      await processor.processDue(at(10), 20, t.tenantId);
      const [doc] = await docFor(order.id);
      expect(doc).toMatchObject({ status: 'not_authorized', next_retry_at: null });
      expect(doc.sri_messages[0]).toMatchObject({ identificador: '39', mensaje: 'FIRMA INVALIDA' });
    });

    it('SRI caído: reintenta con backoff exponencial (30 s, 60 s) sin perder el XML firmado', async () => {
      const order = await paidOrder();
      sri.reception = 'down';
      const t0 = at(1);
      await processor.processDue(t0, 20, t.tenantId);
      let [doc] = await docFor(order.id);
      expect(doc).toMatchObject({ status: 'signed', attempts: 1 });
      expect(new Date(doc.next_retry_at).getTime() - t0.getTime()).toBe(30_000);

      await processor.processDue(new Date(t0.getTime() + 10_000), 20, t.tenantId); // todavía no toca
      expect((await docFor(order.id))[0].attempts).toBe(1);

      const t1 = new Date(t0.getTime() + 31_000);
      await processor.processDue(t1, 20, t.tenantId);
      [doc] = await docFor(order.id);
      expect(doc).toMatchObject({ status: 'signed', attempts: 2 });
      expect(new Date(doc.next_retry_at).getTime() - t1.getTime()).toBe(60_000);

      sri.reception = 'ok';
      await processor.processDue(new Date(t1.getTime() + 61_000), 20, t.tenantId);
      expect((await docFor(order.id))[0]).toMatchObject({ status: 'received', attempts: 0 });
    });

    it('timeout esperando la recepción: queda "sent"; al reenviar, CLAVE ACCESO REGISTRADA (43) cuenta como recibida', async () => {
      const order = await paidOrder();
      sri.reception = 'timeout';
      const t0 = at(1);
      await processor.processDue(t0, 20, t.tenantId);
      let [doc] = await docFor(order.id);
      expect(doc).toMatchObject({ status: 'sent', attempts: 1 });
      expect(sri.received.has(doc.access_key)).toBe(true); // sí llegó

      sri.reception = 'ok';
      await processor.processDue(new Date(t0.getTime() + 31_000), 20, t.tenantId);
      [doc] = await docFor(order.id);
      expect(doc).toMatchObject({ status: 'received', attempts: 0 });
      expect(doc.sri_messages[0]).toMatchObject({ identificador: '43' });
    });

    it('si el email falla, la factura queda autorizada y el email se reintenta', async () => {
      const order = await paidOrder();
      sri.pendingPolls = 0;
      await processor.processDue(at(1), 20, t.tenantId);
      mailer.failNext = 1;
      const t1 = at(10);
      await processor.processDue(t1, 20, t.tenantId);
      let [doc] = await docFor(order.id);
      expect(doc).toMatchObject({ status: 'authorized', emailed_at: null, attempts: 1 });

      await processor.processDue(new Date(t1.getTime() + 31_000), 20, t.tenantId);
      [doc] = await docFor(order.id);
      expect(doc.emailed_at).not.toBeNull();
      expect(mailer.sent.filter((m) => m.text.includes(doc.access_key))).toHaveLength(1);
    });
  });
});
