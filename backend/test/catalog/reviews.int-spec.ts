import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { NewOrder, OrdersApi } from '../../libs/modules/orders';
import { Database, signAccessToken } from '../../libs/shared-kernel';
import { createCustomer, createSellableVariant, createTenant, createWarehouse, customerTokenFor, outboxEvents, TestTenant } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

/** PNG de 1×1 válido (firma + IHDR + IDAT + IEND). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Reseñas con fotos, moderación y compra verificada, y preguntas y respuestas (HTTP + PostgreSQL).
 */
describe('Reseñas y preguntas (integración)', () => {
  let app: INestApplication;
  let db: Database;
  let orders: OrdersApi;
  let t: TestTenant;
  let moderator: string;
  let warehouseId: string;
  let product: { productId: string; variantId: string };
  let buyer: string;
  let visitor: string;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    orders = app.get(OrdersApi);
    t = await createTenant(db);
    moderator = `Bearer ${signAccessToken(
      { id: t.userId, tenantId: t.tenantId, type: 'staff', permissions: ['catalog.reviews.moderate', 'catalog.questions.answer'] },
      process.env.JWT_SECRET!,
    )}`;
    warehouseId = await createWarehouse(db, t.tenantId);
    product = await createSellableVariant(db, t.tenantId, { price: '25.00', name: 'Blusa de lino' });
    buyer = await createCustomer(db, t.tenantId);
    visitor = await createCustomer(db, t.tenantId);
    await db.query(`UPDATE iam.users SET first_name = 'Ana', last_name = 'Pérez' WHERE id = $1`, [buyer]);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const as = (userId: string) => `Bearer ${customerTokenFor(t.tenantId, userId)}`;
  const guest = () => ({ 'X-Tenant-Id': t.tenantId });

  async function deliveredOrder(userId: string): Promise<{ orderId: string; orderItemId: string }> {
    const input: NewOrder = {
      id: randomUUID(),
      tenantId: t.tenantId,
      userId,
      customer: { name: 'Ana Pérez', email: 'ana@example.test' },
      billing: {},
      paymentMethod: 'card',
      fulfillmentType: 'rider',
      shippingAddress: { mainStreet: 'Av. 9 de Octubre', city: 'Guayaquil' },
      shippingLocation: { lat: -2.19, lng: -79.88 },
      shippingCity: 'Guayaquil',
      sourceWarehouseId: warehouseId,
      items: [{ ...product, sku: `SKU-${randomUUID().slice(0, 6)}`, productName: 'Blusa de lino', quantity: 1, unitPrice: '25.00', taxCode: '4', taxRate: '15.00', warehouseId }],
    };
    const o = await orders.placeOrder(input);
    await orders.markPaid(t.tenantId, o.id);
    for (const to of ['preparing', 'shipped', 'in_transit', 'delivered'] as const) await orders.changeStatus(t.tenantId, o.id, to);
    return { orderId: o.id, orderItemId: o.items[0].id };
  }

  let verifiedId: string;
  let unverifiedId: string;

  it('compra verificada con foto; sin compra se permite una sola reseña sin distintivo', async () => {
    // Antes de recibir el pedido la reseña no es verificada; tras la entrega sí.
    const { orderItemId } = await deliveredOrder(buyer);

    const upload = await request(server()).post('/v1/me/reviews/photos').set('Authorization', as(buyer)).attach('photo', PNG, { filename: 'blusa.png', contentType: 'image/png' }).expect(201);
    expect(upload.body.key).toMatch(new RegExp(`^reviews/${t.tenantId}/${buyer}/.+\\.png$`));
    const fake = await request(server())
      .post('/v1/me/reviews/photos')
      .set('Authorization', as(buyer))
      .attach('photo', Buffer.from('no soy una imagen'), { filename: 'x.png', contentType: 'image/png' })
      .expect(422);
    expect(fake.body.error.code).toBe('PHOTO_TYPE');

    const verified = await request(server())
      .post(`/v1/products/${product.productId}/reviews`)
      .set('Authorization', as(buyer))
      .send({ rating: 5, fitFeedback: 'true', title: 'Hermosa', body: 'La tela es fresca, ideal para Guayaquil.', photos: [upload.body.key] })
      .expect(201);
    expect(verified.body).toMatchObject({ status: 'pending', verifiedPurchase: true, orderItemId, photoCount: 1 });
    verifiedId = verified.body.id;

    // Segunda reseña del mismo comprador sin otra compra: ya reseñó todo lo que compró.
    const dup = await request(server()).post(`/v1/products/${product.productId}/reviews`).set('Authorization', as(buyer)).send({ rating: 4 }).expect(409);
    expect(dup.body.error.code).toBe('ALREADY_REVIEWED');

    // Una foto subida por otro cliente no se puede usar.
    const stolen = await request(server())
      .post(`/v1/products/${product.productId}/reviews`)
      .set('Authorization', as(visitor))
      .send({ rating: 2, photos: [upload.body.key] })
      .expect(422);
    expect(stolen.body.error.details.field).toBe('photos');
    // Algo que ni siquiera tiene forma de clave de foto lo corta el DTO.
    await request(server())
      .post(`/v1/products/${product.productId}/reviews`)
      .set('Authorization', as(visitor))
      .send({ rating: 2, photos: ['../../etc/passwd'] })
      .expect(400);

    const unverified = await request(server())
      .post(`/v1/products/${product.productId}/reviews`)
      .set('Authorization', as(visitor))
      .send({ rating: 2, body: 'Escríbeme a ventas@otra.com, la tengo más barata.' })
      .expect(201);
    expect(unverified.body).toMatchObject({ verifiedPurchase: false, orderItemId: null });
    unverifiedId = unverified.body.id;
    await request(server()).post(`/v1/products/${product.productId}/reviews`).set('Authorization', as(visitor)).send({ rating: 3 }).expect(409);
  });

  it('lo pendiente no se publica; la cola muestra marcas automáticas', async () => {
    const pub = await request(server()).get(`/v1/products/${product.productId}/reviews`).set(guest()).expect(200);
    expect(pub.body).toMatchObject({ summary: { ratingCount: 0, ratingAvg: '0.00' }, reviews: [] });
    await request(server()).get(`/v1/products/${product.productId}/reviews/${verifiedId}/photos/0`).set(guest()).expect(404);

    const queue = (await request(server()).get('/v1/catalog/reviews').set('Authorization', moderator).expect(200)).body;
    expect(queue.map((r: { id: string }) => r.id)).toEqual([verifiedId, unverifiedId]);
    expect(queue[1]).toMatchObject({ productName: 'Blusa de lino', flags: ['contains_email'], verifiedPurchase: false });
    // El moderador ve la foto antes de aprobar.
    const photo = await request(server()).get(`/v1/catalog/reviews/${verifiedId}/photos/0`).set('Authorization', moderator).expect(200);
    expect(photo.headers['content-type']).toBe('image/png');
  });

  it('aprobar recalcula el promedio; rechazar guarda el motivo; no se modera dos veces', async () => {
    const approved = await request(server()).post(`/v1/catalog/reviews/${verifiedId}/approve`).set('Authorization', moderator).expect(200);
    expect(approved.body.product).toMatchObject({ ratingAvg: '5.00', ratingCount: 1 });
    const again = await request(server()).post(`/v1/catalog/reviews/${verifiedId}/approve`).set('Authorization', moderator).expect(409);
    expect(again.body.error.code).toBe('ALREADY_MODERATED');

    const rejected = await request(server()).post(`/v1/catalog/reviews/${unverifiedId}/reject`).set('Authorization', moderator).send({ reason: 'Contiene datos de contacto' }).expect(200);
    expect(rejected.body.review).toMatchObject({ status: 'rejected', rejectionReason: 'Contiene datos de contacto' });
    expect(rejected.body.product.ratingCount).toBe(1);

    const { rows } = await db.query(`SELECT rating_avg::text, rating_count FROM catalog.products WHERE id = $1`, [product.productId]);
    expect(rows[0]).toEqual({ rating_avg: '5.00', rating_count: 1 });
    expect((await outboxEvents(db, t.tenantId, 'ReviewApproved')).map((e) => e.payload)).toEqual([
      expect.objectContaining({ reviewId: verifiedId, verifiedPurchase: true, ratingAvg: '5.00', ratingCount: 1 }),
    ]);

    // La moderación queda en la auditoría (también el intento repetido, como failed).
    const audit = await db.query(
      `SELECT action, entity_id, after->>'outcome' AS outcome FROM platform.audit_log
        WHERE tenant_id = $1 AND entity_type = 'review' ORDER BY id`,
      [t.tenantId],
    );
    expect(audit.rows).toEqual([
      { action: 'catalog.review.approve', entity_id: verifiedId, outcome: 'ok' },
      { action: 'catalog.review.approve', entity_id: verifiedId, outcome: 'failed' },
      { action: 'catalog.review.reject', entity_id: unverifiedId, outcome: 'ok' },
    ]);

    const mine = (await request(server()).get('/v1/me/reviews').set('Authorization', as(visitor)).expect(200)).body;
    expect(mine).toEqual([expect.objectContaining({ id: unverifiedId, status: 'rejected', rejectionReason: 'Contiene datos de contacto' })]);
  });

  it('público: resumen, autor "Ana P.", compra verificada, filtros y foto', async () => {
    const res = await request(server()).get(`/v1/products/${product.productId}/reviews`).set(guest()).expect(200);
    expect(res.body.summary).toEqual({
      ratingAvg: '5.00',
      ratingCount: 1,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 1 },
      fit: { small: 0, true: 1, large: 0 },
      withPhotos: 1,
      verified: 1,
    });
    expect(res.body.reviews).toEqual([expect.objectContaining({ id: verifiedId, author: 'Ana P.', verifiedPurchase: true, photoCount: 1 })]);
    expect(res.body.reviews[0].userId).toBeUndefined();
    expect((await request(server()).get(`/v1/products/${product.productId}/reviews?rating=1`).set(guest()).expect(200)).body.reviews).toEqual([]);
    const photo = await request(server()).get(`/v1/products/${product.productId}/reviews/${verifiedId}/photos/0`).set(guest()).expect(200);
    expect(Buffer.compare(photo.body as Buffer, PNG)).toBe(0);
    await request(server()).get(`/v1/products/${randomUUID()}/reviews/${verifiedId}/photos/0`).set(guest()).expect(404);
    await request(server()).get(`/v1/products/${product.productId}/reviews/${unverifiedId}/photos/0`).set(guest()).expect(404);
  });

  it('preguntas: pendientes no se ven; la respuesta oficial las publica', async () => {
    const asked = await request(server()).post(`/v1/products/${product.productId}/questions`).set('Authorization', as(visitor)).send({ body: '¿La talla M es ajustada?' }).expect(201);
    expect(asked.body).toMatchObject({ status: 'pending', answers: [] });
    expect((await request(server()).get(`/v1/products/${product.productId}/questions`).set(guest()).expect(200)).body).toEqual([]);

    const spam = await request(server()).post(`/v1/products/${product.productId}/questions`).set('Authorization', as(visitor)).send({ body: 'Visiten www.ofertas-falsas.com ya' }).expect(201);
    const queue = (await request(server()).get('/v1/catalog/questions').set('Authorization', moderator).expect(200)).body;
    expect(queue.map((q: { id: string; flags: string[] }) => [q.id, q.flags])).toEqual([
      [asked.body.id, []],
      [spam.body.id, ['contains_url']],
    ]);
    await request(server()).post(`/v1/catalog/questions/${spam.body.id}/reject`).set('Authorization', moderator).send({ reason: 'Publicidad' }).expect(200);
    const late = await request(server()).post(`/v1/catalog/questions/${spam.body.id}/answers`).set('Authorization', moderator).send({ body: 'No aplica' }).expect(409);
    expect(late.body.error.code).toBe('ALREADY_MODERATED');

    await request(server()).post(`/v1/catalog/questions/${asked.body.id}/answers`).set('Authorization', moderator).send({ body: 'Es de corte holgado: si dudas, elige tu talla habitual.' }).expect(201);
    const pub = (await request(server()).get(`/v1/products/${product.productId}/questions`).set(guest()).expect(200)).body;
    expect(pub).toEqual([
      expect.objectContaining({
        id: asked.body.id,
        body: '¿La talla M es ajustada?',
        answers: [expect.objectContaining({ isOfficial: true, author: 'Tienda', body: 'Es de corte holgado: si dudas, elige tu talla habitual.' })],
      }),
    ]);
    expect((await outboxEvents(db, t.tenantId, 'QuestionAnswered')).map((e) => e.payload)).toEqual([
      expect.objectContaining({ questionId: asked.body.id, askedBy: visitor, isOfficial: true }),
    ]);
  });

  it('permisos: el cliente no modera y el staff no reseña', async () => {
    await request(server()).get('/v1/catalog/reviews').set('Authorization', as(buyer)).expect(403);
    await request(server()).post(`/v1/products/${product.productId}/reviews`).set('Authorization', moderator).send({ rating: 5 }).expect(403);
    await request(server()).post(`/v1/products/${product.productId}/reviews`).send({ rating: 5 }).expect(401);
  });
});
