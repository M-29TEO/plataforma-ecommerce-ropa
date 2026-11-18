import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Database } from '../../libs/shared-kernel';
import { loginAs, registerCustomer, TEST_PASSWORD } from '../support/iam';
import { createShop, deliveryBody, postCheckout, Shop } from '../support/shop';
import { createTestApp } from '../support/test-app';

/**
 * LOPDP: exportar mis datos (acceso y portabilidad) y anonimizar la cuenta (eliminación), con lo
 * que la ley obliga a conservar (comprobantes del SRI) declarado en el informe.
 */
describe('Privacidad (LOPDP): exportar mis datos y anonimizar la cuenta', () => {
  let app: INestApplication;
  let db: Database;
  let shop: Shop;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    shop = await createShop(db);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Cliente registrado por la API, con un pedido contra entrega, una dirección y una suscripción push. */
  async function customerWithData() {
    const email = `titular-${randomUUID().slice(0, 8)}@example.test`;
    const id = await registerCustomer(server(), shop.tenantId, email, TEST_PASSWORD);
    const bearer = `Bearer ${await loginAs(server(), shop.tenantId, email)}`;
    await request(server()).post('/v1/cart/items').set('Authorization', bearer).send({ variantId: shop.blusa, quantity: 1 }).expect(200);
    const body = await deliveryBody(app, shop.tenantId, { bearer }, { paymentMethod: 'cod', customer: { name: 'Titular Prueba', email, phone: '0991234567' } });
    const order = await postCheckout(app, shop.tenantId, { bearer }, body);
    if (order.status !== 201) throw new Error(`checkout ${order.status}: ${JSON.stringify(order.body)}`);
    await request(server())
      .post('/v1/me/addresses')
      .set('Authorization', bearer)
      .send({ recipientName: 'Titular Prueba', recipientPhone: '0991234567', province: 'Pichincha', city: 'Quito', mainStreet: 'Av. Amazonas', pin: { lat: -0.18, lng: -78.47 } })
      .expect(201);
    await request(server())
      .post('/v1/me/push-subscriptions')
      .set('Authorization', bearer)
      .send({ endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: 'a'.repeat(40), auth: 'b'.repeat(16) } })
      .expect(201);
    return { id, email, bearer, orderId: order.body.orderId as string };
  }

  it('exporta todo lo que la tienda guarda del titular, sin secretos', async () => {
    const c = await customerWithData();
    const res = await request(server()).get('/v1/me/privacy/export').set('Authorization', c.bearer).expect(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="mis-datos-\d{4}-\d{2}-\d{2}\.json"$/);
    const { secciones } = res.body;
    expect(Object.keys(secciones)).toEqual(expect.arrayContaining(['cuenta', 'pedidos', 'cliente', 'notificaciones', 'facturas']));
    expect(JSON.stringify(secciones.cuenta)).toContain(c.email);
    expect(JSON.stringify(secciones.pedidos)).toContain(c.orderId);
    const raw = JSON.stringify(res.body);
    for (const secret of ['password', 'passwordHash', 'password_hash', 'token_hash', 'mfa_secret', 'keys_enc', TEST_PASSWORD]) expect(raw).not.toContain(secret);
    // Queda en la auditoría quién descargó los datos.
    const audit = await db.query(`SELECT 1 FROM platform.audit_log WHERE action = 'privacy.data.export' AND actor_id = $1`, [c.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('anonimizar exige la frase, la contraseña y que no haya operaciones en curso', async () => {
    const c = await customerWithData();
    const anonymize = (body: Record<string, unknown>) => request(server()).post('/v1/me/privacy/anonymize').set('Authorization', c.bearer).send(body);

    await anonymize({ password: TEST_PASSWORD, confirm: 'si' }).expect(400);
    const wrong = await anonymize({ password: 'otra-clave-123', confirm: 'ELIMINAR MI CUENTA' }).expect(422);
    expect(wrong.body.error.code).toBe('INVALID_PASSWORD');
    const open = await anonymize({ password: TEST_PASSWORD, confirm: 'ELIMINAR MI CUENTA' }).expect(409);
    expect(open.body.error.code).toBe('ACCOUNT_HAS_OPEN_OPERATIONS');
    expect(open.body.error.details.blockers.join()).toMatch(/Pedido #\d+ en curso/);
    // Nada cambió.
    const still = await db.query(`SELECT status FROM iam.users WHERE id = $1`, [c.id]);
    expect(still.rows[0].status).toBe('active');
  });

  it('anonimiza: borra contacto, direcciones y suscripciones; conserva los pedidos sin datos personales', async () => {
    const c = await customerWithData();
    // Pedido entregado: ya no bloquea (en la base, como si Logística lo hubiera cerrado).
    await db.query(`UPDATE sales.orders SET status = 'delivered' WHERE id = $1`, [c.orderId]);
    await db.query(`UPDATE logistics.shipments SET status = 'delivered' WHERE order_id = $1`, [c.orderId]);

    const res = await request(server())
      .post('/v1/me/privacy/anonymize')
      .set('Authorization', c.bearer)
      .send({ password: TEST_PASSWORD, confirm: 'ELIMINAR MI CUENTA' })
      .expect(200);
    expect(res.body.secciones.map((s: { seccion: string }) => s.seccion).at(-1)).toBe('cuenta'); // IAM al final
    expect(res.body.conservado.join(' ')).toMatch(/SRI/);

    const user = (await db.query(`SELECT email, phone, first_name, password_hash, status FROM iam.users WHERE id = $1`, [c.id])).rows[0];
    expect(user).toMatchObject({ phone: null, first_name: null, password_hash: null, status: 'anonymized' });
    expect(user.email).not.toContain('titular-');
    expect((await db.query(`SELECT 1 FROM iam.refresh_tokens WHERE user_id = $1`, [c.id])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM crm.addresses WHERE user_id = $1`, [c.id])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM platform.push_subscriptions WHERE user_id = $1`, [c.id])).rowCount).toBe(0);

    // El pedido sigue (contabilidad y reportes) pero sin nombre, email, teléfono ni calle.
    const order = (await db.query(`SELECT customer, shipping_address FROM sales.orders WHERE id = $1`, [c.orderId])).rows[0];
    const orderText = JSON.stringify(order);
    for (const pii of [c.email, 'Titular Prueba', '0991234567', 'Amazonas']) expect(orderText).not.toContain(pii);

    // Ya no puede iniciar sesión y la acción quedó auditada en la misma transacción.
    await request(server()).post('/v1/auth/login').set('X-Tenant-Id', shop.tenantId).send({ email: c.email, password: TEST_PASSWORD }).expect(401);
    const audit = await db.query(`SELECT after FROM platform.audit_log WHERE action = 'privacy.account.anonymized' AND entity_id = $1`, [c.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('staff y motorizados no se anonimizan por autoservicio', async () => {
    const { tokenFor } = await import('../support/fixtures');
    const res = await request(server())
      .post('/v1/me/privacy/anonymize')
      .set('Authorization', `Bearer ${tokenFor(shop, [])}`)
      .send({ password: 'x', confirm: 'ELIMINAR MI CUENTA' })
      .expect(403);
    expect(res.body.error.code).toBe('CUSTOMERS_ONLY');
  });
});
