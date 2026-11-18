import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AbandonedCartService } from '../../libs/modules/cart';
import { DeliveryQuoteService } from '../../libs/modules/logistics/application/delivery-quote.service';
import { NotificationsApi } from '../../libs/modules/notifications';
import { CHANNEL_PORTS, ChannelPort } from '../../libs/modules/notifications/application/ports';
import { InMemoryChannel } from '../../libs/modules/notifications/infrastructure/channels/in-memory.channel';
import { SimulatedMessagingChannel } from '../../libs/modules/notifications/infrastructure/channels/simulated.channel';
import { Database, OutboxRelay, OutboxWriter } from '../../libs/shared-kernel';
import { createCustomer, customerTokenFor, tokenFor } from '../support/fixtures';
import { countRows, createShop, customerCart, deliveryBody, guestCart, postCheckout, Shop } from '../support/shop';
import { createTestApp } from '../support/test-app';

interface NotificationRow {
  id: string;
  channel: string;
  template_code: string;
  recipient: string;
  status: string;
  attempts: number;
  error: string | null;
  payload: { subject: string | null; text: string; html: string | null; url: string | null; locale: string; category: string };
  next_attempt_at: Date | null;
}

/**
 * Módulo Notificaciones de punta a punta: eventos reales (checkout, logística, carrito) → relay →
 * filas en platform.notifications → despachador → canales en memoria (NOTIFICATION_TRANSPORT=memory).
 */
describe('Notificaciones', () => {
  let app: INestApplication;
  let db: Database;
  let relay: OutboxRelay;
  let api: NotificationsApi;
  let carts: AbandonedCartService;
  let outbox: OutboxWriter;
  let shop: Shop;
  let channels: Record<string, ChannelPort>;

  const mem = (c: 'email' | 'webpush' | 'ntfy') => channels[c] as InMemoryChannel;
  const sim = (c: 'whatsapp' | 'sms') => channels[c] as SimulatedMessagingChannel;

  beforeAll(async () => {
    ({ app, db, relay } = await createTestApp({ withConsumers: true, withNotifications: true }));
    api = app.get(NotificationsApi);
    carts = app.get(AbandonedCartService);
    outbox = app.get(OutboxWriter);
    channels = Object.fromEntries((app.get(CHANNEL_PORTS) as ChannelPort[]).map((p) => [p.channel, p]));
    shop = await createShop(db, { blusa: 100, bolso: 100 });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mem('email').clear();
    mem('webpush').clear();
    mem('ntfy').clear();
  });

  async function rows(where: string, values: unknown[]): Promise<NotificationRow[]> {
    const { rows } = await db.query<NotificationRow>(
      `SELECT id, channel, template_code, recipient, status, attempts, error, payload, next_attempt_at
         FROM platform.notifications WHERE tenant_id = $1 AND ${where} ORDER BY channel, recipient`,
      [shop.tenantId, ...values],
    );
    return rows;
  }

  const dispatch = (now?: Date) => api.dispatchDue(now, 50, shop.tenantId);

  async function placeGuestOrder(): Promise<string> {
    const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
    const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie }));
    expect(res.status).toBe(201);
    await relay.drain({ tenantId: shop.tenantId });
    return res.body.orderId as string;
  }

  async function customerWithToken(phone: string | null = null, locale = 'es-EC') {
    const id = await createCustomer(db, shop.tenantId);
    await db.query(`UPDATE iam.users SET phone = $2, locale = $3, first_name = 'Lucía' WHERE id = $1`, [id, phone, locale]);
    return { id, bearer: `Bearer ${customerTokenFor(shop.tenantId, id)}` };
  }

  async function subscribePush(bearer: string): Promise<string> {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    await request(app.getHttpServer())
      .post('/v1/me/push-subscriptions')
      .set('Authorization', bearer)
      .send({ endpoint, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } })
      .expect(201);
    return endpoint;
  }

  // ------------------------------------------------------------------------- pedidos

  it('OrderPlaced (invitado): email + WhatsApp simulado, sin Web Push; el despachador los envía', async () => {
    const orderId = await placeGuestOrder();
    const queued = await rows(`template_code = 'order.placed' AND payload->>'url' LIKE $2`, [`%${orderId}`]);
    expect(queued.map((r) => [r.channel, r.recipient, r.status])).toEqual([
      ['email', 'ana@example.test', 'queued'],
      ['whatsapp', '+593991234567', 'queued'],
    ]);
    const email = queued.find((r) => r.channel === 'email')!;
    expect(email.payload.subject).toMatch(/^Recibimos tu pedido #\d+$/);
    expect(email.payload.html).toContain('Blusa lino');
    expect(email.payload.category).toBe('transactional');

    const before = sim('whatsapp').sent.length;
    const run = await dispatch();
    expect(run.sent).toBeGreaterThanOrEqual(2);
    expect(mem('email').sent.find((m) => m.notificationId === email.id)).toMatchObject({ recipient: 'ana@example.test' });
    expect(sim('whatsapp').sent.length).toBe(before + 1);
    expect(sim('whatsapp').sent.at(-1)!.text).toContain('recibimos tu pedido');
    const sent = await rows(`id = $2`, [email.id]);
    expect(sent[0]).toMatchObject({ status: 'sent', attempts: 1, next_attempt_at: null });
  });

  it('un evento entregado dos veces no duplica (dedupe_key)', async () => {
    const orderId = await placeGuestOrder();
    const { rows: ev } = await db.query(
      `SELECT aggregate_id, payload FROM platform.outbox_events WHERE tenant_id = $1 AND event_type = 'OrderPlaced' AND aggregate_id = $2`,
      [shop.tenantId, orderId],
    );
    await outbox.append(db, [{ tenantId: shop.tenantId, aggregateType: 'sales.order', aggregateId: orderId, eventType: 'OrderPlaced', payload: ev[0].payload }]);
    await relay.drain({ tenantId: shop.tenantId });
    expect(await countRows(db, `SELECT count(*) AS n FROM platform.notifications WHERE tenant_id = $1 AND template_code = 'order.placed' AND payload->>'url' LIKE $2`, [shop.tenantId, `%${orderId}`])).toBe(2);
  });

  it('cliente registrado con Web Push: push con su idioma; 410 del servicio push borra la suscripción', async () => {
    const c = await customerWithToken(null, 'en-US');
    const endpoint = await subscribePush(c.bearer);
    const bearer = await customerCart(app, { ...shop, customerId: c.id }, [{ variantId: shop.bolso, quantity: 1 }]);
    const res = await postCheckout(app, shop.tenantId, { bearer }, await deliveryBody(app, shop.tenantId, { bearer }));
    expect(res.status).toBe(201);
    await relay.drain({ tenantId: shop.tenantId });

    const push = await rows(`template_code = 'order.placed' AND channel = 'webpush' AND recipient = $2`, [endpoint]);
    expect(push).toHaveLength(1);
    expect(push[0].payload).toMatchObject({ locale: 'en-US' });
    expect(push[0].payload.subject).toMatch(/^Order #\d+ received$/);

    mem('webpush').failNext = ['gone'];
    await dispatch();
    expect((await rows(`id = $2`, [push[0].id]))[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await countRows(db, `SELECT count(*) AS n FROM platform.push_subscriptions WHERE endpoint = $1`, [endpoint])).toBe(0);
  });

  it('falla transitoria: reintenta con backoff y luego envía; agotados los intentos queda failed', async () => {
    await dispatch(); // vacía la cola de los tests anteriores: failNext debe caer en ESTE email
    const orderId = await placeGuestOrder();
    const [email] = await rows(`template_code = 'order.placed' AND channel = 'email' AND payload->>'url' LIKE $2`, [`%${orderId}`]);
    mem('email').failNext = ['transient'];
    const now = new Date();
    await dispatch(now);
    const retried = (await rows(`id = $2`, [email.id]))[0];
    expect(retried).toMatchObject({ status: 'queued', attempts: 1 });
    expect(retried.error).toContain('no disponible');
    expect(retried.next_attempt_at!.getTime()).toBeGreaterThan(now.getTime() + 20_000);

    // Antes del backoff no se toca; después, se envía.
    await dispatch(now);
    expect(mem('email').sent.some((m) => m.notificationId === email.id)).toBe(false);
    await dispatch(new Date(now.getTime() + 3600_000));
    expect((await rows(`id = $2`, [email.id]))[0]).toMatchObject({ status: 'sent', attempts: 2, error: null });

    // Error permanente (4xx): failed sin reintentos.
    const other = await placeGuestOrder();
    const [email2] = await rows(`template_code = 'order.placed' AND channel = 'email' AND payload->>'url' LIKE $2`, [`%${other}`]);
    mem('email').failNext = ['permanent'];
    await dispatch();
    expect((await rows(`id = $2`, [email2.id]))[0]).toMatchObject({ status: 'failed', attempts: 1 });
  });

  // ------------------------------------------------------------------------- envíos y facturas

  it('ShipmentStatusChanged: in_transit avisa por push y email; la entrega del pedido no se duplica; la cancelación del envío se emite', async () => {
    const c = await customerWithToken('0987654321');
    await subscribePush(c.bearer);
    const bearer = await customerCart(app, { ...shop, customerId: c.id }, [{ variantId: shop.blusa, quantity: 1 }]);
    const res = await postCheckout(app, shop.tenantId, { bearer }, await deliveryBody(app, shop.tenantId, { bearer }));
    const orderId = res.body.orderId as string;
    await relay.drain({ tenantId: shop.tenantId });
    const { rows: ship } = await db.query<{ id: string; tracking_token: string }>(
      `SELECT id, tracking_token FROM logistics.shipments WHERE order_id = $1`,
      [orderId],
    );
    const base = { shipmentId: ship[0].id, orderId, returnId: null, direction: 'outbound', carrierType: 'rider', previousStatus: 'assigned', trackingToken: ship[0].tracking_token, description: null };
    await outbox.append(db, [
      { tenantId: shop.tenantId, aggregateType: 'logistics.shipment', aggregateId: ship[0].id, eventType: 'ShipmentStatusChanged', payload: { ...base, status: 'in_transit', occurredAt: '2026-10-01T15:00:00.000Z' } },
      { tenantId: shop.tenantId, aggregateType: 'logistics.shipment', aggregateId: ship[0].id, eventType: 'ShipmentStatusChanged', payload: { ...base, status: 'delivered', occurredAt: '2026-10-01T16:00:00.000Z' } },
    ]);
    await relay.drain({ tenantId: shop.tenantId });

    const shipRows = await rows(`template_code LIKE 'shipment.%' AND user_id = $2`, [c.id]);
    expect(shipRows.map((r) => [r.template_code, r.channel])).toEqual([
      ['shipment.in_transit', 'email'],
      ['shipment.in_transit', 'webpush'],
    ]);
    expect(shipRows[0].payload.url).toBe(`http://localhost/seguimiento/${ship[0].tracking_token}`);

    // Logística emite ShipmentStatusChanged al cancelar los envíos pendientes de un pedido.
    const other = await placeGuestOrder();
    await app.get(DeliveryQuoteService).cancelForOrder(shop.tenantId, other, 'Pago rechazado');
    const { rows: ev } = await db.query(
      `SELECT payload FROM platform.outbox_events WHERE tenant_id = $1 AND event_type = 'ShipmentStatusChanged' AND payload->>'orderId' = $2`,
      [shop.tenantId, other],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ previousStatus: 'pending', status: 'cancelled', direction: 'outbound', description: 'Pago rechazado' });
    await relay.drain({ tenantId: shop.tenantId });
    expect(await countRows(db, `SELECT count(*) AS n FROM platform.notifications WHERE tenant_id = $1 AND template_code = 'shipment.cancelled'`, [shop.tenantId])).toBe(0);
  });

  it('InvoiceRejected: alerta ntfy al tópico del backoffice; InvoiceAuthorized: push al cliente', async () => {
    const orderId = await placeGuestOrder();
    const documentId = randomUUID();
    await outbox.append(db, [
      {
        tenantId: shop.tenantId,
        aggregateType: 'billing.electronic_document',
        aggregateId: documentId,
        eventType: 'InvoiceRejected',
        payload: {
          documentId,
          docType: '01',
          orderId,
          accessKey: '0110202601179000000000110010010000000011234567813',
          status: 'returned',
          messages: [{ identificador: '35', mensaje: 'ARCHIVO NO CUMPLE ESTRUCTURA XML', informacionAdicional: null, tipo: 'ERROR' }],
        },
      },
    ]);
    await relay.drain({ tenantId: shop.tenantId });
    const [alert] = await rows(`template_code = 'invoice.rejected'`, []);
    expect(alert).toMatchObject({ channel: 'ntfy', recipient: 'moda-demo-backoffice', status: 'queued' });
    expect(alert.payload.subject).toBe('SRI: factura DEVUELTA');
    expect(alert.payload.text).toContain('35 ARCHIVO NO CUMPLE ESTRUCTURA XML');
    await dispatch();
    expect(mem('ntfy').sent.map((m) => m.recipient)).toContain('moda-demo-backoffice');

    // El invitado no tiene suscripción push: InvoiceAuthorized no genera filas.
    await outbox.append(db, [
      {
        tenantId: shop.tenantId,
        aggregateType: 'billing.electronic_document',
        aggregateId: documentId,
        eventType: 'InvoiceAuthorized',
        payload: { documentId, docType: '01', orderId, accessKey: 'x', authorizationNumber: 'x', authorizedAt: new Date().toISOString(), total: '26.00', buyerEmail: 'ana@example.test' },
      },
    ]);
    await relay.drain({ tenantId: shop.tenantId });
    expect(await rows(`template_code = 'invoice.authorized'`, [])).toHaveLength(0);
  });

  // ------------------------------------------------------------------------- consentimientos

  it('consentimientos LOPDP: sin filas todo es false; PUT agrega historial y GET muestra el vigente', async () => {
    const c = await customerWithToken();
    const initial = await request(app.getHttpServer()).get('/v1/me/consents').set('Authorization', c.bearer).expect(200);
    expect(initial.body.find((s: { purpose: string }) => s.purpose === 'marketing_email')).toMatchObject({ granted: false, updatedAt: null });

    await request(app.getHttpServer())
      .put('/v1/me/consents')
      .set('Authorization', c.bearer)
      .send({ policyVersion: '2026-09', consents: [{ purpose: 'marketing_email', granted: true }] })
      .expect(200);
    const revoked = await request(app.getHttpServer())
      .put('/v1/me/consents')
      .set('Authorization', c.bearer)
      .send({ policyVersion: '2026-09', consents: [{ purpose: 'marketing_email', granted: false }] })
      .expect(200);
    expect(revoked.body.find((s: { purpose: string }) => s.purpose === 'marketing_email')).toMatchObject({ granted: false, policyVersion: '2026-09' });
    expect(await countRows(db, `SELECT count(*) AS n FROM iam.consents WHERE user_id = $1`, [c.id])).toBe(2);

    await request(app.getHttpServer()).put('/v1/me/consents').set('Authorization', c.bearer).send({ policyVersion: 'v', consents: [{ purpose: 'otra', granted: true }] }).expect(400);
  });

  // ------------------------------------------------------------------------- carrito abandonado

  async function ageCart(cartId: string, hours: number) {
    await db.query(`UPDATE sales.carts SET last_activity_at = now() - make_interval(mins => $2) WHERE id = $1`, [cartId, Math.round(hours * 60)]);
  }

  async function cartState(cartId: string) {
    const { rows } = await db.query<{ reminders_sent: number; status: string }>(`SELECT reminders_sent, status FROM sales.carts WHERE id = $1`, [cartId]);
    return rows[0];
  }

  it('recordatorios a 1 h, 24 h y 72 h: marketing suprimido sin consentimiento, enviado con él y vuelto a suprimir al revocarlo', async () => {
    const c = await customerWithToken('0991112233');
    await customerCart(app, { ...shop, customerId: c.id }, [{ variantId: shop.blusa, quantity: 2 }]);
    const { rows: cart } = await db.query<{ id: string }>(`SELECT id FROM sales.carts WHERE user_id = $1 AND status = 'active'`, [c.id]);
    const cartId = cart[0].id;

    // 30 min: todavía no.
    await ageCart(cartId, 0.5);
    expect((await carts.processDue(new Date(), 50, shop.tenantId)).reminded).toBe(0);

    // 1 h sin consentimiento: email y WhatsApp quedan suprimidos (evidencia), no se envían.
    await ageCart(cartId, 1.5);
    expect((await carts.processDue(new Date(), 50, shop.tenantId)).reminded).toBe(1);
    expect(await cartState(cartId)).toEqual({ reminders_sent: 1, status: 'active' });
    await relay.drain({ tenantId: shop.tenantId });
    const stage1 = await rows(`template_code = 'cart.reminder.1h' AND user_id = $2`, [c.id]);
    expect(stage1.map((r) => [r.channel, r.status, r.error])).toEqual([
      ['email', 'suppressed', 'Sin consentimiento marketing_email'],
      ['whatsapp', 'suppressed', 'Sin consentimiento marketing_whatsapp'],
    ]);
    // Una segunda pasada a la misma hora no repite la etapa.
    expect((await carts.processDue(new Date(), 50, shop.tenantId)).reminded).toBe(0);

    // Otorga marketing por email (no por WhatsApp). 24 h: email en cola con el pie de consentimiento.
    await request(app.getHttpServer())
      .put('/v1/me/consents')
      .set('Authorization', c.bearer)
      .send({ policyVersion: '2026-09', consents: [{ purpose: 'marketing_email', granted: true }] })
      .expect(200);
    await ageCart(cartId, 25);
    expect((await carts.processDue(new Date(), 50, shop.tenantId)).reminded).toBe(1);
    await relay.drain({ tenantId: shop.tenantId });
    const stage2 = await rows(`template_code = 'cart.reminder.24h' AND user_id = $2`, [c.id]);
    expect(stage2.map((r) => [r.channel, r.status])).toEqual([
      ['email', 'queued'],
      ['whatsapp', 'suppressed'],
    ]);
    expect(stage2[0].payload.category).toBe('marketing');
    expect(stage2[0].payload.html).toContain('/mi-cuenta/privacidad');
    expect(stage2[0].payload.html).toContain('2 × Blusa lino');
    await dispatch();
    expect(mem('email').sent.some((m) => m.notificationId === stage2[0].id)).toBe(true);

    // Revoca. 72 h: todo suprimido (email, WhatsApp y SMS). Después del tercero, nada más.
    await request(app.getHttpServer())
      .put('/v1/me/consents')
      .set('Authorization', c.bearer)
      .send({ policyVersion: '2026-09', consents: [{ purpose: 'marketing_email', granted: false }] })
      .expect(200);
    await ageCart(cartId, 73);
    expect((await carts.processDue(new Date(), 50, shop.tenantId)).reminded).toBe(1);
    await relay.drain({ tenantId: shop.tenantId });
    const stage3 = await rows(`template_code = 'cart.reminder.72h' AND user_id = $2`, [c.id]);
    expect(stage3.map((r) => [r.channel, r.status])).toEqual([
      ['email', 'suppressed'],
      ['sms', 'suppressed'],
      ['whatsapp', 'suppressed'],
    ]);
    await ageCart(cartId, 500);
    expect((await carts.processDue(new Date(), 50, shop.tenantId)).reminded).toBe(0);
    // El carrito sigue activo: el cliente puede volver a él.
    expect(await cartState(cartId)).toEqual({ reminders_sent: 3, status: 'active' });

    // Nueva actividad: la cuenta se reinicia.
    await request(app.getHttpServer()).post('/v1/cart/items').set('Authorization', c.bearer).send({ variantId: shop.bolso, quantity: 1 }).expect(200);
    expect((await cartState(cartId)).reminders_sent).toBe(0);
  });

  it('job detenido: si ya pasaron 80 h se envía solo la etapa de 72 h; carritos vacíos o sin contacto no cuentan', async () => {
    const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
    await request(app.getHttpServer())
      .put('/v1/cart/contact')
      .set('X-Tenant-Id', shop.tenantId)
      .set('Cookie', `cart_token=${cookie}`)
      .send({ email: `invitado+${randomUUID().slice(0, 6)}@example.test` })
      .expect(200);
    const { rows: c } = await db.query<{ id: string }>(
      `SELECT id FROM sales.carts WHERE tenant_id = $1 AND user_id IS NULL AND contact_email LIKE 'invitado+%' ORDER BY created_at DESC LIMIT 1`,
      [shop.tenantId],
    );
    const cartId = c[0].id;
    // Otro carrito de invitado sin contacto: no es candidato.
    const anonymous = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
    expect(anonymous).toBeTruthy();
    await db.query(`UPDATE sales.carts SET last_activity_at = now() - interval '80 hours' WHERE tenant_id = $1 AND status = 'active' AND user_id IS NULL`, [shop.tenantId]);

    const run = await carts.processDue(new Date(), 50, shop.tenantId);
    expect(run.reminded).toBe(1);
    expect(await cartState(cartId)).toEqual({ reminders_sent: 3, status: 'active' });
    const { rows: ev } = await db.query(`SELECT payload FROM platform.outbox_events WHERE event_type = 'CartAbandoned' AND aggregate_id = $1`, [cartId]);
    expect(ev.map((e) => e.payload.stageLabel)).toEqual(['72h']);
    expect(ev[0].payload).toMatchObject({ itemCount: 1, total: '23.00', userId: null });
  });

  it('dos pasadas simultáneas del job no recuerdan dos veces el mismo carrito (SKIP LOCKED + UPDATE condicional)', async () => {
    const c = await customerWithToken();
    await customerCart(app, { ...shop, customerId: c.id }, [{ variantId: shop.blusa, quantity: 1 }]);
    const { rows: cart } = await db.query<{ id: string }>(`SELECT id FROM sales.carts WHERE user_id = $1 AND status = 'active'`, [c.id]);
    await ageCart(cart[0].id, 2);
    const runs = await Promise.all([carts.processDue(new Date(), 50, shop.tenantId), carts.processDue(new Date(), 50, shop.tenantId)]);
    expect(runs[0].reminded + runs[1].reminded).toBe(1);
    expect(await countRows(db, `SELECT count(*) AS n FROM platform.outbox_events WHERE event_type = 'CartAbandoned' AND aggregate_id = $1`, [cart[0].id])).toBe(1);
  });

  // ------------------------------------------------------------------------- plantillas, push y bandeja

  it('plantilla propia del tenant: se valida, manda sobre la del sistema y no puede cambiar la categoría', async () => {
    const staff = `Bearer ${tokenFor(shop, ['notifications.read', 'notifications.templates.write'])}`;
    const http = request(app.getHttpServer());
    await http
      .put('/v1/notifications/templates/order.placed/whatsapp/es-EC')
      .set('Authorization', staff)
      .send({ body: '{{#if x}}sin cerrar' })
      .expect(422);
    await http.put('/v1/notifications/templates/order.placed/sms/es-EC').set('Authorization', staff).send({ body: 'x' }).expect(422);
    await http.put('/v1/notifications/templates/cart.reminder.1h/email/es-EC').set('Authorization', staff).send({ body: '<p>hola</p>' }).expect(422);
    // Salida sin escapar ({{{ }}} / {{& }}): inyección de HTML con datos del cliente.
    for (const body of ['<p>Hola {{{name}}}</p>', '<p>{{& name}}</p>', '<p>{{~{name}~}}</p>']) {
      const unescaped = await http.put('/v1/notifications/templates/order.placed/email/es-EC').set('Authorization', staff).send({ subject: 'x', body });
      expect([unescaped.status, unescaped.body.error?.code]).toEqual([422, 'UNESCAPED_TEMPLATE']);
    }

    const saved = await http
      .put('/v1/notifications/templates/order.placed/whatsapp/es-EC')
      .set('Authorization', staff)
      .send({ body: 'Pedido #{{orderNumber}} confirmado. ¡Gracias, {{name}}!' })
      .expect(200);
    expect(saved.body).toMatchObject({ category: 'transactional', active: true, subject: null });
    const marketing = await http
      .put('/v1/notifications/templates/cart.reminder.1h/email/es-EC')
      .set('Authorization', staff)
      .send({ subject: 'Vuelve', body: '<p>Te esperamos</p>' })
      .expect(200);
    expect(marketing.body.category).toBe('marketing');

    const catalog = await http.get('/v1/notifications/templates').set('Authorization', staff).expect(200);
    expect(catalog.body.templates.find((t: { code: string }) => t.code === 'order.placed').overrides).toHaveLength(1);

    const orderId = await placeGuestOrder();
    const [wa] = await rows(`template_code = 'order.placed' AND channel = 'whatsapp' AND payload->>'url' LIKE $2`, [`%${orderId}`]);
    expect(wa.payload.text).toMatch(/^Pedido #\d+ confirmado\. ¡Gracias, Ana!$/);

    // active=false apaga el mensaje por ese canal.
    await http.put('/v1/notifications/templates/order.placed/whatsapp/es-EC').set('Authorization', staff).send({ body: 'x', active: false }).expect(200);
    const next = await placeGuestOrder();
    expect(await rows(`template_code = 'order.placed' AND channel = 'whatsapp' AND payload->>'url' LIKE $2`, [`%${next}`])).toHaveLength(0);

    // Bandeja del backoffice, filtrada.
    const failed = await http.get('/v1/notifications?status=suppressed&channel=email').set('Authorization', staff).expect(200);
    expect(failed.body.every((n: { status: string; channel: string }) => n.status === 'suppressed' && n.channel === 'email')).toBe(true);
    await http.get('/v1/notifications').set('Authorization', `Bearer ${tokenFor(shop, [])}`).expect(403);
  });

  it('Web Push: clave pública, suscripción idempotente por endpoint, baja y "mis notificaciones"', async () => {
    const http = request(app.getHttpServer());
    const key = await http.get('/v1/notifications/push/public-key').expect(200);
    expect(key.body).toEqual({ publicKey: null });

    const c = await customerWithToken();
    const endpoint = await subscribePush(c.bearer);
    await subscribePush(c.bearer);
    await http
      .post('/v1/me/push-subscriptions')
      .set('Authorization', c.bearer)
      .send({ endpoint, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u', auth: 'tBHItJI5svbpez7KI4CCXg' } })
      .expect(201);
    expect(await countRows(db, `SELECT count(*) AS n FROM platform.push_subscriptions WHERE user_id = $1`, [c.id])).toBe(2);
    await http.post('/v1/me/push-subscriptions').set('Authorization', c.bearer).send({ endpoint: 'http://inseguro.test/x', keys: { p256dh: 'a'.repeat(20), auth: 'b'.repeat(10) } }).expect(400);

    // SSRF: un endpoint HTTPS que no es de un servicio push de navegador no se registra.
    for (const internal of ['https://169.254.169.254/latest/meta-data', 'https://localhost/x', 'https://valkey:6379/x', 'https://fcm.googleapis.com.evil.test/x']) {
      const r = await http.post('/v1/me/push-subscriptions').set('Authorization', c.bearer).send({ endpoint: internal, keys: { p256dh: 'a'.repeat(20), auth: 'b'.repeat(10) } });
      expect([r.status, r.body.error?.code]).toEqual([422, 'PUSH_ENDPOINT_NOT_ALLOWED']);
    }
    // Otro cliente no se queda con el endpoint (y las notificaciones) de c.
    const other = await customerWithToken();
    const taken = await http.post('/v1/me/push-subscriptions').set('Authorization', other.bearer).send({ endpoint, keys: { p256dh: 'a'.repeat(20), auth: 'b'.repeat(10) } });
    expect([taken.status, taken.body.error?.code]).toEqual([409, 'PUSH_ENDPOINT_TAKEN']);
    // Las claves del navegador quedan cifradas (libsodium): ni el secreto auth ni p256dh en claro.
    const { rows: stored } = await db.query<{ keys_enc: Buffer; user_id: string }>(`SELECT keys_enc, user_id FROM platform.push_subscriptions WHERE endpoint = $1`, [endpoint]);
    expect(stored[0].user_id).toBe(c.id);
    expect(stored[0].keys_enc.toString('latin1')).not.toContain('tBHItJI5svbpez7KI4CCXg');

    await http.delete('/v1/me/push-subscriptions').set('Authorization', c.bearer).send({ endpoint }).expect(204);
    expect(await countRows(db, `SELECT count(*) AS n FROM platform.push_subscriptions WHERE user_id = $1`, [c.id])).toBe(1);

    const mine = await http.get('/v1/me/notifications').set('Authorization', c.bearer).expect(200);
    expect(Array.isArray(mine.body)).toBe(true);
  });

  it('usuario anonimizado (derecho de supresión): no se le escribe por ningún canal', async () => {
    const c = await customerWithToken('0991234567');
    await customerCart(app, { ...shop, customerId: c.id }, [{ variantId: shop.blusa, quantity: 1 }]);
    await db.query(`UPDATE iam.users SET status = 'anonymized' WHERE id = $1`, [c.id]);
    const { rows: cart } = await db.query<{ id: string }>(`SELECT id FROM sales.carts WHERE user_id = $1 AND status = 'active'`, [c.id]);
    await ageCart(cart[0].id, 2);
    await carts.processDue(new Date(), 50, shop.tenantId);
    await relay.drain({ tenantId: shop.tenantId });
    expect(await rows(`user_id = $2`, [c.id])).toHaveLength(0);
  });
});
