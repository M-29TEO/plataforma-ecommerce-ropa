import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { LogisticsApi } from '../../libs/modules/logistics';
import { SlaMonitorService } from '../../libs/modules/support/application/sla-monitor.service';
import { Database, OutboxRelay, OutboxWriter } from '../../libs/shared-kernel';
import { createStaff, customerTokenFor, tokenFor } from '../support/fixtures';
import { countRows, createShop, customerCart, CUSTOMER, deliveryBody, guestCart, postCheckout, Shop } from '../support/shop';
import { createTestApp } from '../support/test-app';

const ALL = ['support.tickets.read', 'support.tickets.write', 'support.tickets.assign'];
const HOUR = 3_600_000;

interface NotificationRow {
  template_code: string;
  channel: string;
  recipient: string;
  status: string;
  payload: { subject: string | null; text: string; html: string | null; url: string | null };
}

/**
 * Soporte de punta a punta: HTTP (cliente, invitado con enlace firmado y backoffice) → tablas
 * support.* → outbox → consumidores de Notificaciones y Soporte → platform.notifications.
 */
describe('Soporte', () => {
  let app: INestApplication;
  let db: Database;
  let relay: OutboxRelay;
  let monitor: SlaMonitorService;
  let shop: Shop;
  let staffBearer: string;
  let customerBearer: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, db, relay } = await createTestApp({ withConsumers: true, withNotifications: true, withSupport: true }));
    monitor = app.get(SlaMonitorService);
    shop = await createShop(db, { blusa: 100, bolso: 100 });
    staffBearer = `Bearer ${tokenFor(shop, ALL)}`;
    customerBearer = `Bearer ${customerTokenFor(shop.tenantId, shop.customerId)}`;
  });

  afterAll(async () => {
    await app.close();
  });

  const drain = () => relay.drain({ tenantId: shop.tenantId });

  /** Notificaciones de la plantilla cuyo asunto menciona el ticket #number. */
  async function notifications(code: string, number: string): Promise<NotificationRow[]> {
    const { rows } = await db.query<NotificationRow>(
      `SELECT template_code, channel, recipient, status, payload FROM platform.notifications
        WHERE tenant_id = $1 AND template_code = $2 AND payload->>'subject' ~ $3 ORDER BY created_at`,
      [shop.tenantId, code, `#${number}([^0-9]|$)`],
    );
    return rows;
  }

  async function customerOrder(): Promise<string> {
    const bearer = await customerCart(app, shop, [{ variantId: shop.blusa, quantity: 1 }]);
    const res = await postCheckout(app, shop.tenantId, { bearer }, await deliveryBody(app, shop.tenantId, { bearer }));
    expect(res.status).toBe(201);
    await drain();
    return res.body.orderId as string;
  }

  async function guestOrder(): Promise<{ orderId: string; orderNumber: string }> {
    const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.bolso, quantity: 1 }]);
    const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie }));
    expect(res.status).toBe(201);
    await drain();
    const { rows } = await db.query<{ order_number: string }>(`SELECT order_number::text FROM sales.orders WHERE id = $1`, [res.body.orderId]);
    return { orderId: res.body.orderId, orderNumber: rows[0].order_number };
  }

  async function openTicket(body: Record<string, unknown> = {}): Promise<{ id: string; number: string }> {
    const res = await http()
      .post('/v1/me/tickets')
      .set('Authorization', customerBearer)
      .send({ category: 'delivery', subject: 'Mi pedido no llega', body: 'Han pasado 3 días', ...body })
      .expect(201);
    await drain();
    return res.body;
  }

  async function staffTicket(id: string) {
    return (await http().get(`/v1/support/tickets/${id}`).set('Authorization', staffBearer).expect(200)).body;
  }

  /** Token del enlace firmado que llevan los emails (…/soporte/t/<token>). */
  function tokenFrom(url: string | null): string {
    const m = /\/soporte\/t\/([^/?]+)/.exec(url ?? '');
    if (!m) throw new Error(`URL sin token: ${url}`);
    return m[1];
  }

  async function agentWithRole(): Promise<string> {
    const agentId = await createStaff(db, shop.tenantId);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO iam.roles (tenant_id, code, name) VALUES ($1, $2, 'Soporte') RETURNING id`,
      [shop.tenantId, `support-${randomUUID().slice(0, 8)}`],
    );
    await db.query(`INSERT INTO iam.role_permissions (role_id, permission_code) VALUES ($1, 'support.tickets.write')`, [rows[0].id]);
    await db.query(`INSERT INTO iam.user_roles (user_id, role_id) VALUES ($1, $2)`, [agentId, rows[0].id]);
    return agentId;
  }

  // ------------------------------------------------------------------ cliente registrado

  it('cliente: ticket sobre su pedido y su envío, con SLA por prioridad y acuse por email', async () => {
    const orderId = await customerOrder();
    const [shipment] = await app.get(LogisticsApi).getShipments(shop.tenantId, orderId);
    expect(shipment).toBeDefined();

    const ticket = await openTicket({ orderId, shipmentId: shipment.id });
    expect(ticket).toMatchObject({ status: 'open', orderId, shipmentId: shipment.id, canRate: false });
    expect(ticket).not.toHaveProperty('assignedTo');
    expect(ticket.number).toMatch(/^\d+$/);

    const row = await staffTicket(ticket.id);
    expect(row.priority).toBe('normal');
    expect(new Date(row.slaDueAt).getTime() - new Date(row.createdAt).getTime()).toBe(24 * HOUR);

    const [ack] = await notifications('ticket.created', ticket.number);
    expect(ack).toMatchObject({ channel: 'email', status: 'queued' });
    expect(ack.recipient).toMatch(/^cliente\+.*@example\.test$/);
    expect(ack.payload.subject).toBe(`Recibimos tu solicitud #${ticket.number}: Mi pedido no llega`);
  });

  it('cliente: no puede vincular un pedido ajeno ni un envío de otro pedido', async () => {
    const { orderId: guestOrderId } = await guestOrder();
    const other = await http()
      .post('/v1/me/tickets')
      .set('Authorization', customerBearer)
      .send({ category: 'delivery', subject: 'Ajeno', body: 'x', orderId: guestOrderId })
      .expect(404);
    expect(other.body.error.code).toBe('TICKET_ORDER_NOT_FOUND');

    const mine = await customerOrder();
    const wrong = await http()
      .post('/v1/me/tickets')
      .set('Authorization', customerBearer)
      .send({ category: 'delivery', subject: 'Envío', body: 'x', orderId: mine, shipmentId: randomUUID() })
      .expect(404);
    expect(wrong.body.error.code).toBe('TICKET_SHIPMENT_NOT_FOUND');
  });

  // ------------------------------------------------------------------ backoffice

  it('agente: toma, nota interna, responde por email; el cliente no ve la nota y su respuesta reabre la cola', async () => {
    const ticket = await openTicket();

    const taken = await http().post(`/v1/support/tickets/${ticket.id}/take`).set('Authorization', staffBearer).send({}).expect(200);
    expect(taken.body).toMatchObject({ status: 'in_progress', assignedTo: shop.userId, version: 2 });

    await http().post(`/v1/support/tickets/${ticket.id}/notes`).set('Authorization', staffBearer).send({ body: 'Llamar al motorizado' }).expect(201);
    const replied = await http()
      .post(`/v1/support/tickets/${ticket.id}/replies`)
      .set('Authorization', staffBearer)
      .send({ body: 'Tu pedido sale hoy.\nTe avisamos al despachar.' })
      .expect(201);
    expect(replied.body.status).toBe('pending_customer');
    expect(replied.body.firstResponseAt).not.toBeNull();
    await drain();

    const [email] = await notifications('ticket.reply', ticket.number);
    expect(email).toMatchObject({ channel: 'email', status: 'queued' });
    expect(email.payload.html).toContain('Tu pedido sale hoy.');
    expect(email.payload.html).not.toContain('Llamar al motorizado');

    const view = await http().get(`/v1/me/tickets/${ticket.id}`).set('Authorization', customerBearer).expect(200);
    expect(view.body.messages.map((m: { author: string; body: string }) => [m.author, m.body])).toEqual([
      ['customer', 'Han pasado 3 días'],
      ['agent', 'Tu pedido sale hoy.\nTe avisamos al despachar.'],
    ]);

    const back = await http().post(`/v1/me/tickets/${ticket.id}/messages`).set('Authorization', customerBearer).send({ body: 'Gracias, espero' }).expect(201);
    expect(back.body.status).toBe('in_progress');

    const full = await staffTicket(ticket.id);
    expect(full.messages.filter((m: { isInternal: boolean }) => m.isInternal).map((m: { body: string }) => m.body)).toContain('Llamar al motorizado');

    const queue = await http().get('/v1/support/tickets?assignedTo=me&status=in_progress').set('Authorization', staffBearer).expect(200);
    expect(queue.body.map((t: { id: string }) => t.id)).toContain(ticket.id);
  });

  it('concurrencia optimista: una versión vieja responde 409', async () => {
    const ticket = await openTicket();
    const current = await staffTicket(ticket.id);
    await http().patch(`/v1/support/tickets/${ticket.id}`).set('Authorization', staffBearer).send({ priority: 'high', expectedVersion: current.version }).expect(200);
    const stale = await http()
      .patch(`/v1/support/tickets/${ticket.id}`)
      .set('Authorization', staffBearer)
      .send({ status: 'resolved', expectedVersion: current.version })
      .expect(409);
    expect(stale.body.error.code).toBe('STALE_VERSION');
  });

  it('asignación: solo a agentes (staff con support.tickets.write) y con el permiso support.tickets.assign', async () => {
    const ticket = await openTicket();
    const notAgent = await createStaff(db, shop.tenantId);
    const bad = await http().put(`/v1/support/tickets/${ticket.id}/assignee`).set('Authorization', staffBearer).send({ agentId: notAgent }).expect(422);
    expect(bad.body.error.code).toBe('INVALID_AGENT');

    const agent = await agentWithRole();
    const ok = await http().put(`/v1/support/tickets/${ticket.id}/assignee`).set('Authorization', staffBearer).send({ agentId: agent }).expect(200);
    expect(ok.body).toMatchObject({ assignedTo: agent, status: 'in_progress' });

    const writer = `Bearer ${tokenFor(shop, ['support.tickets.read', 'support.tickets.write'])}`;
    await http().put(`/v1/support/tickets/${ticket.id}/assignee`).set('Authorization', writer).send({ agentId: null }).expect(403);
    await http().get('/v1/support/tickets').set('Authorization', customerBearer).expect(403);
  });

  it('cierre: encuesta CSAT por email; el cliente califica una sola vez', async () => {
    const ticket = await openTicket();
    await http().post(`/v1/support/tickets/${ticket.id}/replies`).set('Authorization', staffBearer).send({ body: 'Listo', status: 'resolved' }).expect(201);
    const early = await http().post(`/v1/me/tickets/${ticket.id}/csat`).set('Authorization', customerBearer).send({ score: 5 }).expect(409);
    expect(early.body.error.code).toBe('CSAT_NOT_ALLOWED');

    const closed = await http().patch(`/v1/support/tickets/${ticket.id}`).set('Authorization', staffBearer).send({ status: 'closed' }).expect(200);
    expect(closed.body.closedAt).not.toBeNull();
    await drain();
    const [survey] = await notifications('ticket.csat', ticket.number);
    // Handlebars escapa el '=' del atributo (&#x3D;); el navegador lo decodifica.
    expect(survey.payload.html).toContain('/encuesta?score&#x3D;5');
    expect(survey.payload.text).toContain('/encuesta?score=5');

    const rated = await http().post(`/v1/me/tickets/${ticket.id}/csat`).set('Authorization', customerBearer).send({ score: 4, comment: 'Rápidos' }).expect(200);
    expect(rated.body).toMatchObject({ csat: 4, canRate: false });
    await http().post(`/v1/me/tickets/${ticket.id}/csat`).set('Authorization', customerBearer).send({ score: 5 }).expect(409);
    await http().post(`/v1/me/tickets/${ticket.id}/messages`).set('Authorization', customerBearer).send({ body: 'Hola' }).expect(409);
  });

  // ------------------------------------------------------------------ invitado

  it('invitado: abre con número de pedido + email; el enlace del email permite ver, responder y calificar', async () => {
    const { orderId, orderNumber } = await guestOrder();
    const wrong = await http()
      .post('/v1/support/guest-tickets')
      .set('X-Tenant-Id', shop.tenantId)
      .send({ orderNumber, email: 'otra@example.test', category: 'product', subject: 'Talla', body: 'x' })
      .expect(404);
    expect(wrong.body.error.code).toBe('TICKET_ORDER_NOT_FOUND');

    const created = await http()
      .post('/v1/support/guest-tickets')
      .set('X-Tenant-Id', shop.tenantId)
      .send({ orderNumber, email: CUSTOMER.email.toUpperCase(), category: 'product', subject: 'Talla equivocada', body: 'Pedí M y llegó S' })
      .expect(201);
    expect(created.body).toEqual({ number: expect.stringMatching(/^\d+$/), status: 'open' });
    await drain();

    const [ack] = await notifications('ticket.created', created.body.number);
    expect(ack.recipient).toBe(CUSTOMER.email);
    const token = tokenFrom(ack.payload.url);

    const view = await http().get(`/v1/support/ticket-links/${token}`).expect(200);
    expect(view.body).toMatchObject({ number: created.body.number, orderId, status: 'open' });
    await http().post(`/v1/support/ticket-links/${token}/messages`).send({ body: 'Adjunto foto luego' }).expect(201);

    const id = view.body.id as string;
    await http().post(`/v1/support/tickets/${id}/replies`).set('Authorization', staffBearer).send({ body: 'Te enviamos la M', status: 'resolved' }).expect(201);
    await http().patch(`/v1/support/tickets/${id}`).set('Authorization', staffBearer).send({ status: 'closed' }).expect(200);
    const rated = await http().post(`/v1/support/ticket-links/${token}/csat`).send({ score: 5 }).expect(200);
    expect(rated.body.csat).toBe(5);

    const forged = `${token.split('.')[0]}.AAAA`;
    expect((await http().get(`/v1/support/ticket-links/${forged}`).expect(404)).body.error.code).toBe('TICKET_LINK_INVALID');
    // Sin forma de enlace (no es payload.firma en base64url, o es enorme): 400 antes del HMAC.
    await http().get('/v1/support/ticket-links/no-es-un-token').expect(400);
    await http().get(`/v1/support/ticket-links/${'a'.repeat(700)}.${'b'.repeat(43)}`).expect(400);
    await http().post('/v1/support/ticket-links/a.b.c/messages').send({ body: 'hola' }).expect(400);

    // El personal que abre la ficha del ticket (PII del invitado) queda en la auditoría.
    await http().get(`/v1/support/tickets/${id}`).set('Authorization', staffBearer).expect(200);
    const audit = await db.query(
      `SELECT action, after->>'outcome' AS outcome FROM platform.audit_log WHERE entity_type = 'ticket' AND entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        { action: 'support.ticket.update', outcome: 'ok' },
        { action: 'support.ticket.view', outcome: 'ok' },
      ]),
    );
  });

  // ------------------------------------------------------------------ SLA y job

  it('SLA vencido: alerta ntfy al backoffice una sola vez; pending_customer no alerta', async () => {
    const urgent = await openTicket({ subject: 'Cobro doble' });
    await http().patch(`/v1/support/tickets/${urgent.id}`).set('Authorization', staffBearer).send({ priority: 'urgent' }).expect(200);
    const waiting = await openTicket({ subject: 'Esperando datos' });
    await http().patch(`/v1/support/tickets/${waiting.id}`).set('Authorization', staffBearer).send({ priority: 'urgent', status: 'pending_customer' }).expect(200);

    const later = new Date(Date.now() + 5 * HOUR);
    const run = await monitor.sweep(later, 50, shop.tenantId);
    expect(run.breached).toBeGreaterThanOrEqual(1);
    expect((await staffTicket(urgent.id)).slaBreachedAt).not.toBeNull();
    expect((await staffTicket(waiting.id)).slaBreachedAt).toBeNull();
    await drain();

    const alerts = await notifications('ticket.sla_breached', urgent.number);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ channel: 'ntfy', recipient: 'moda-demo-backoffice' });
    expect(alerts[0].payload.subject).toBe(`Soporte: SLA vencido #${urgent.number} (urgent)`);

    const again = await monitor.sweep(new Date(later.getTime() + HOUR), 50, shop.tenantId);
    expect(again.breached).toBe(0);
    // La cola compara con la hora real: se adelanta el vencimiento de los dos tickets.
    await db.query(`UPDATE support.tickets SET sla_due_at = now() - interval '1 hour' WHERE id = ANY($1::uuid[])`, [[urgent.id, waiting.id]]);
    const overdue = await http().get('/v1/support/tickets?overdue=true').set('Authorization', staffBearer).expect(200);
    expect(overdue.body.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([urgent.id, waiting.id]));
  });

  it('cierre automático: un ticket resuelto sin respuesta se cierra a los N días y sale la encuesta', async () => {
    const ticket = await openTicket();
    await http().patch(`/v1/support/tickets/${ticket.id}`).set('Authorization', staffBearer).send({ status: 'resolved' }).expect(200);
    expect((await monitor.sweep(new Date(Date.now() + 2 * 24 * HOUR), 50, shop.tenantId)).autoClosed).toBe(0);
    const run = await monitor.sweep(new Date(Date.now() + 4 * 24 * HOUR), 50, shop.tenantId);
    expect(run.autoClosed).toBeGreaterThanOrEqual(1);
    expect((await staffTicket(ticket.id)).status).toBe('closed');
    await drain();
    expect(await notifications('ticket.csat', ticket.number)).toHaveLength(1);
  });

  // ------------------------------------------------------------------ eventos de otros módulos

  it('InvoiceRejected abre un ticket interno (sin emails al cliente); un evento repetido no lo duplica', async () => {
    const orderId = await customerOrder();
    const documentId = randomUUID();
    const event = {
      tenantId: shop.tenantId,
      aggregateType: 'billing.document',
      aggregateId: documentId,
      eventType: 'InvoiceRejected',
      payload: {
        documentId,
        docType: '01',
        orderId,
        accessKey: '0'.repeat(49),
        status: 'returned',
        messages: [{ identificador: '35', mensaje: 'ARCHIVO NO CUMPLE ESTRUCTURA XML', informacionAdicional: null, tipo: 'ERROR' }],
      },
    };
    const outbox = app.get(OutboxWriter);
    await outbox.append(db, [event]);
    await drain();
    await outbox.append(db, [event]);
    await drain();

    const { rows } = await db.query<{ id: string; number: string; channel: string; category: string; priority: string; subject: string; requester_id: string | null }>(
      `SELECT id, number::text, channel, category, priority, subject, requester_id FROM support.tickets WHERE tenant_id = $1 AND source_ref = $2`,
      [shop.tenantId, `invoice:${documentId}:returned`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'internal', category: 'invoice', priority: 'high', requester_id: null });
    expect(rows[0].subject).toMatch(/^Factura DEVUELTA por el SRI · pedido #\d+$/);
    expect(await notifications('ticket.created', rows[0].number)).toHaveLength(0);

    const reply = await http().post(`/v1/support/tickets/${rows[0].id}/replies`).set('Authorization', staffBearer).send({ body: 'x' }).expect(422);
    expect(reply.body.error.code).toBe('TICKET_WITHOUT_REQUESTER');
    expect(await countRows(db, `SELECT count(*) AS n FROM support.ticket_messages WHERE ticket_id = $1`, [rows[0].id])).toBe(1);
  });

  it('ticket registrado por el agente sobre un pedido: el cliente es el del pedido', async () => {
    const orderId = await customerOrder();
    const res = await http()
      .post('/v1/support/tickets')
      .set('Authorization', staffBearer)
      .send({ channel: 'phone', category: 'payment', priority: 'high', subject: 'Llamó por el cobro', body: 'Dice que le cobraron dos veces', orderId, assignToMe: true })
      .expect(201);
    expect(res.body).toMatchObject({ requesterId: shop.customerId, channel: 'phone', status: 'in_progress', assignedTo: shop.userId });
    expect(res.body.requesterContact).toMatchObject({ email: CUSTOMER.email });
  });
});
