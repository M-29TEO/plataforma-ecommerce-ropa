import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { LogisticsApi } from '../../libs/modules/logistics';
import { DispatchService } from '../../libs/modules/logistics/application/dispatch.service';
import { RiderOfferNotifier } from '../../libs/modules/logistics/application/rider-app-ports';
import { deliveryOtpCode } from '../../libs/modules/logistics/domain/delivery-proof';
import { InMemoryRiderOfferNotifier } from '../../libs/modules/logistics/infrastructure/notifier/ntfy-rider-offer.notifier';
import { NewOrder, OrdersApi } from '../../libs/modules/orders';
import { APP_CONFIG, AppConfig, Database, OutboxRelay, signAccessToken } from '../../libs/shared-kernel';
import { createCustomer, createRider, createSellableVariant, createTenant, createWarehouse, customerTokenFor, outboxEvents, riderTokenFor, TestTenant } from '../support/fixtures';
import { deliverMultipart, JPEG_TINY, PNG_1X1 } from '../support/rider';
import { createTestApp } from '../support/test-app';

const WAREHOUSE = { lat: -0.15, lng: -78.485 };
/** Destino en Quito (La Carolina), ~3 km al sur de la bodega. */
const DEST = { lat: -0.1765, lng: -78.4844 };
/** Motorizados a ~110 m, ~1,1 km y ~2,2 km de la bodega: el despacho ofrece en ese orden. */
const NEAR = { lat: -0.151, lng: -78.485 };
const MID = { lat: -0.16, lng: -78.485 };
const FAR = { lat: -0.17, lng: -78.485 };

type Rider = { riderId: string; userId: string };

/**
 * App del motorizado: perfil, turnos, despacho automático (oferta → rechazo → siguiente → acepta,
 * vencimiento por el job), entrega con foto, firma y código (bloqueo por fuerza bruta), contra
 * entrega y ganancias; y las pruebas de entrega en el backoffice.
 */
describe('App del motorizado (integración)', () => {
  let app: INestApplication;
  let db: Database;
  let relay: OutboxRelay;
  let orders: OrdersApi;
  let dispatch: DispatchService;
  let notifier: InMemoryRiderOfferNotifier;
  let config: AppConfig;
  let t: TestTenant;
  let warehouseId: string;
  let product: { productId: string; variantId: string };
  let customerId: string;
  let a: Rider;
  let b: Rider;
  let c: Rider;
  // Envío que recorre el despacho automático y luego se entrega con prueba.
  let first: { orderId: string; shipmentId: string; token: string };

  beforeAll(async () => {
    ({ app, db, relay } = await createTestApp({ withConsumers: true }));
    orders = app.get(OrdersApi);
    dispatch = app.get(DispatchService);
    notifier = app.get(RiderOfferNotifier) as InMemoryRiderOfferNotifier;
    config = app.get<AppConfig>(APP_CONFIG);
    t = await createTenant(db);
    warehouseId = await createWarehouse(db, t.tenantId, WAREHOUSE);
    product = await createSellableVariant(db, t.tenantId, { price: '30.00', name: 'Chaqueta' });
    customerId = await createCustomer(db, t.tenantId);
    [a, b, c] = [await createRider(db, t.tenantId), await createRider(db, t.tenantId), await createRider(db, t.tenantId)];
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const staff = (permissions: string[]) =>
    `Bearer ${signAccessToken({ id: t.userId, tenantId: t.tenantId, type: 'staff', permissions }, process.env.JWT_SECRET!)}`;
  const as = (r: Rider) => `Bearer ${riderTokenFor(t.tenantId, r.userId)}`;
  const otpOf = (shipmentId: string) => deliveryOtpCode(config.logistics.deliveryOtpSecret, shipmentId);
  const offersOf = async (r: Rider) => (await request(server()).get('/v1/rider/offers').set('Authorization', as(r)).expect(200)).body;
  const setStatus = (r: Rider, id: string, status: string, extra: object = {}) =>
    request(server()).post(`/v1/rider/shipments/${id}/status`).set('Authorization', as(r)).send({ status, ...extra });

  async function riderOrder(opts: { cod?: boolean; status?: string } = {}): Promise<{ orderId: string; shipmentId: string; token: string }> {
    const address = { mainStreet: 'Av. Amazonas', secondaryStreet: 'Naciones Unidas', reference: 'Casa azul, timbre 3', city: 'Quito' };
    const input: NewOrder = {
      id: randomUUID(),
      tenantId: t.tenantId,
      userId: customerId,
      customer: { name: 'Lucía Torres', email: 'lucia@example.test', phone: '0991234567' },
      billing: {},
      paymentMethod: opts.cod ? 'cod' : 'card',
      fulfillmentType: 'rider',
      shippingAddress: address,
      shippingLocation: DEST,
      shippingCity: 'Quito',
      sourceWarehouseId: warehouseId,
      items: [{ ...product, sku: `SKU-${randomUUID().slice(0, 6)}`, productName: 'Chaqueta', quantity: 1, unitPrice: '30.00', taxCode: '4', taxRate: '15.00', warehouseId }],
    };
    const o = await orders.placeOrder(input);
    if (!opts.cod) await orders.markPaid(t.tenantId, o.id);
    const token = randomBytes(18).toString('base64url');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO logistics.shipments (tenant_id, order_id, carrier_type, tracking_token, status, origin_warehouse_id, destination,
                                        destination_location, weight_g, cod_amount, distance_m)
       VALUES ($1, $2, 'rider', $3, $4, $5, $6::jsonb, ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography, 800, $9, 3000) RETURNING id`,
      [t.tenantId, o.id, token, opts.status ?? 'pending', warehouseId, JSON.stringify(address), DEST.lng, DEST.lat, opts.cod ? '34.50' : '0'],
    );
    return { orderId: o.id, shipmentId: rows[0].id, token };
  }

  it('perfil: datos, efectivo y tópico de ntfy propio y estable; solo para motorizados', async () => {
    const me = await request(server()).get('/v1/rider/me').set('Authorization', as(a)).expect(200);
    expect(me.body).toMatchObject({
      riderId: a.riderId,
      userId: a.userId,
      email: expect.stringMatching(/^moto\+/),
      vehicleType: 'motorcycle',
      status: 'active',
      presence: 'offline',
      ratingAvg: '5.00',
      ratingCount: 0,
      codBalance: '0.00',
      codLimit: '200.00',
      codAvailable: '200.00',
      maxConcurrent: 3,
      ntfy: { url: config.logistics.ntfyPublicUrl, topic: expect.stringMatching(/^rider-[A-Za-z0-9_-]{24}$/) },
      shift: null,
    });
    const again = await request(server()).get('/v1/rider/me').set('Authorization', as(a)).expect(200);
    expect(again.body.ntfy.topic).toBe(me.body.ntfy.topic);
    await request(server()).get('/v1/rider/me').set('Authorization', `Bearer ${customerTokenFor(t.tenantId, customerId)}`).expect(403);
  });

  it('turnos: a demanda o el programado que cubre ahora; uno a la vez; terminar sin turno es 409', async () => {
    const started = await request(server()).post('/v1/rider/shift/start').set('Authorization', as(a)).send(NEAR).expect(201);
    expect(started.body).toMatchObject({ id: expect.any(String), status: 'active', endedAt: null });
    expect(Date.parse(started.body.plannedEndAt) - Date.parse(started.body.startedAt)).toBe(config.logistics.riderShiftDefaultHours * 3_600_000);
    const twice = await request(server()).post('/v1/rider/shift/start').set('Authorization', as(a)).send({}).expect(409);
    expect(twice.body.error.code).toBe('SHIFT_ALREADY_ACTIVE');
    const me = await request(server()).get('/v1/rider/me').set('Authorization', as(a)).expect(200);
    expect(me.body).toMatchObject({ presence: 'available', shift: { id: started.body.id, status: 'active' } });

    // B tiene un turno programado que cubre ahora: se activa ese mismo.
    const scheduled = await db.query<{ id: string }>(
      `INSERT INTO logistics.rider_shifts (rider_id, starts_at, ends_at) VALUES ($1, now() - interval '1 hour', now() + interval '3 hours') RETURNING id`,
      [b.riderId],
    );
    const bShift = await request(server()).post('/v1/rider/shift/start').set('Authorization', as(b)).send(MID).expect(201);
    expect(bShift.body.id).toBe(scheduled.rows[0].id);
    await request(server()).post('/v1/rider/shift/start').set('Authorization', as(c)).send(FAR).expect(201);

    const idle = await createRider(db, t.tenantId);
    expect((await request(server()).post('/v1/rider/shift/end').set('Authorization', as(idle)).expect(409)).body.error.code).toBe('NO_ACTIVE_SHIFT');
  });

  it('despacho: listo para retirar → oferta al más cercano → rechaza → el siguiente acepta', async () => {
    first = await riderOrder();
    await app.get(LogisticsApi).markReadyForPickup({ tenantId: t.tenantId, orderId: first.orderId, fulfillmentType: 'rider', warehouseId, codAmount: '0.00' });
    await relay.drain({ tenantId: t.tenantId });

    // La oferta llega al más cercano a la bodega, sin datos de contacto del cliente.
    const offersA = await offersOf(a);
    expect(offersA).toEqual([
      {
        id: expect.stringMatching(/^\d+$/),
        shipmentId: first.shipmentId,
        offeredAt: expect.any(String),
        expiresAt: expect.any(String),
        pickup: { name: 'Bodega de prueba', location: WAREHOUSE },
        dropoff: { label: 'Av. Amazonas y Naciones Unidas, Quito', location: DEST },
        distanceM: 3000,
        estimatedFee: '3.40',
        codAmount: '0.00',
        slot: null,
      },
    ]);
    expect(JSON.stringify(offersA)).not.toMatch(/timbre|Lucía|0991234567/);
    expect(Date.parse(offersA[0].expiresAt) - Date.parse(offersA[0].offeredAt)).toBe(config.logistics.dispatchOfferTtlSeconds * 1000);
    expect(await offersOf(b)).toEqual([]);
    const row = await db.query<{ score: string; score_breakdown: { distanceM: number } }>(`SELECT score, score_breakdown FROM logistics.dispatch_offers WHERE id = $1`, [offersA[0].id]);
    expect(Number(row.rows[0].score)).toBeGreaterThan(90);
    expect(row.rows[0].score_breakdown.distanceM).toBeLessThan(200);

    // Aviso por ntfy al tópico del motorizado, sin datos del cliente; y la app lo ve al reportar GPS.
    const topicA = (await request(server()).get('/v1/rider/me').set('Authorization', as(a))).body.ntfy.topic;
    expect(notifier.sent.at(-1)).toEqual({
      topic: topicA,
      title: 'Nueva oferta de entrega',
      message: `Tienes ${config.logistics.dispatchOfferTtlSeconds} s para aceptarla`,
      tags: ['motor_scooter'],
      priority: 5,
      click: 'modarider://ofertas',
    });
    expect((await request(server()).post('/v1/rider/location').set('Authorization', as(a)).send(NEAR).expect(202)).body.openOffers).toBe(1);

    // Volver a publicar el evento no crea otra oferta.
    await dispatch.dispatch(t.tenantId, first.shipmentId);
    expect((await db.query(`SELECT 1 FROM logistics.dispatch_offers WHERE shipment_id = $1`, [first.shipmentId])).rowCount).toBe(1);

    // La oferta de otro motorizado no existe para B.
    await request(server()).post(`/v1/rider/offers/${offersA[0].id}/accept`).set('Authorization', as(b)).expect(404);

    await request(server()).post(`/v1/rider/offers/${offersA[0].id}/reject`).set('Authorization', as(a)).send({ reason: 'Estoy cargando gasolina' }).expect(204);
    expect(await offersOf(a)).toEqual([]);
    const rejected = await db.query(`SELECT response, reject_reason FROM logistics.dispatch_offers WHERE id = $1`, [offersA[0].id]);
    expect(rejected.rows[0]).toEqual({ response: 'rejected', reject_reason: 'Estoy cargando gasolina' });
    expect((await request(server()).post(`/v1/rider/offers/${offersA[0].id}/accept`).set('Authorization', as(a)).expect(409)).body.error.code).toBe('OFFER_CLOSED');

    // Pasa de inmediato al siguiente más cercano (B), que acepta.
    const offersB = await offersOf(b);
    expect(offersB).toEqual([expect.objectContaining({ shipmentId: first.shipmentId })]);
    const accepted = await request(server()).post(`/v1/rider/offers/${offersB[0].id}/accept`).set('Authorization', as(b)).expect(200);
    expect(accepted.body).toMatchObject({
      id: first.shipmentId,
      orderId: first.orderId,
      orderNumber: expect.stringMatching(/^\d+$/),
      status: 'accepted',
      pickup: { name: 'Bodega de prueba', location: WAREHOUSE },
      destination: {
        label: 'Av. Amazonas y Naciones Unidas, Quito',
        location: DEST,
        recipientName: 'Lucía Torres',
        phone: '0991234567',
        reference: 'Casa azul, timbre 3',
        mainStreet: 'Av. Amazonas',
      },
      codAmount: '0.00',
      distanceM: 3000,
      estimatedFee: '3.40',
      requiresOtp: true,
      attempts: 0,
      deliveredAt: null,
    });
    expect((await orders.getOrder(t.tenantId, first.orderId)).status).toBe('preparing');
    expect((await request(server()).post(`/v1/rider/offers/${offersB[0].id}/accept`).set('Authorization', as(b)).expect(409)).body.error.code).toBe('OFFER_CLOSED');
    const events = (await outboxEvents(db, t.tenantId, 'ShipmentStatusChanged')).filter((e) => e.aggregate_id === first.shipmentId);
    expect(events.map((e) => e.payload.status)).toEqual(['ready_for_pickup', 'accepted']);
    expect((await request(server()).get('/v1/rider/shipments').set('Authorization', as(b)).expect(200)).body).toEqual([
      expect.objectContaining({ id: first.shipmentId, status: 'accepted' }),
    ]);
  });

  it('vencimiento: el job vence la oferta y la ofrece al siguiente; sin nadie más, queda para el backoffice', async () => {
    const s = await riderOrder({ status: 'ready_for_pickup' });
    await request(server()).post(`/v1/logistics/shipments/${s.shipmentId}/dispatch`).set('Authorization', staff(['logistics.read'])).expect(403);
    const offered = await request(server()).post(`/v1/logistics/shipments/${s.shipmentId}/dispatch`).set('Authorization', staff(['logistics.dispatch'])).expect(200);
    expect(offered.body).toEqual({ offerId: expect.stringMatching(/^\d+$/), riderId: a.riderId, expiresAt: expect.any(String) });
    // Idempotente mientras la oferta está abierta.
    const same = await request(server()).post(`/v1/logistics/shipments/${s.shipmentId}/dispatch`).set('Authorization', staff(['logistics.dispatch'])).expect(200);
    expect(same.body.offerId).toBe(offered.body.offerId);

    const ttl = config.logistics.dispatchOfferTtlSeconds * 1000;
    let clock = Date.now() + ttl + 1000;
    expect(await dispatch.sweep(new Date(clock), t.tenantId)).toEqual({ expired: 1, offered: 1 });
    const expired = await request(server()).post(`/v1/rider/offers/${offered.body.offerId}/accept`).set('Authorization', as(a)).expect(409);
    expect(expired.body.error.code).toBe('OFFER_EXPIRED');
    const next = await db.query<{ rider_id: string }>(`SELECT rider_id FROM logistics.dispatch_offers WHERE shipment_id = $1 AND response IS NULL`, [s.shipmentId]);
    expect(next.rows[0].rider_id).toBe(b.riderId);

    clock += ttl + 1000;
    expect(await dispatch.sweep(new Date(clock), t.tenantId)).toEqual({ expired: 1, offered: 1 }); // a C
    clock += ttl + 1000;
    expect(await dispatch.sweep(new Date(clock), t.tenantId)).toEqual({ expired: 1, offered: 0 }); // nadie más
    const none = await request(server()).post(`/v1/logistics/shipments/${s.shipmentId}/dispatch`).set('Authorization', staff(['logistics.dispatch'])).expect(409);
    expect(none.body.error.code).toBe('NO_RIDER_AVAILABLE');
    const responses = await db.query<{ response: string }>(`SELECT response FROM logistics.dispatch_offers WHERE shipment_id = $1 ORDER BY id`, [s.shipmentId]);
    expect(responses.rows.map((r) => r.response)).toEqual(['expired', 'expired', 'expired']);

    // El backoffice lo asigna a mano (a C, que lo usa la prueba de fin de turno).
    await request(server()).post(`/v1/logistics/shipments/${s.shipmentId}/assign`).set('Authorization', staff(['logistics.dispatch'])).send({ riderId: c.riderId }).expect(200);
  });

  it('entrega con prueba: foto y firma obligatorias, código de entrega con bloqueo por intentos', async () => {
    const id = first.shipmentId;
    const picked = await setStatus(b, id, 'picked_up', WAREHOUSE).expect(200);
    expect(picked.body).toMatchObject({ status: 'picked_up', requiresOtp: true });
    const hash = await db.query<{ otp_hash: Buffer | null }>(`SELECT otp_hash FROM logistics.shipments WHERE id = $1`, [id]);
    expect(hash.rows[0].otp_hash).toHaveLength(32);

    // El cliente ve el código en "mis pedidos" y en el seguimiento público.
    const mine = await request(server()).get(`/v1/me/orders/${first.orderId}/shipments`).set('Authorization', `Bearer ${customerTokenFor(t.tenantId, customerId)}`).expect(200);
    expect(mine.body[0].deliveryCode).toBe(otpOf(id));
    const otp = (await request(server()).get(`/v1/tracking/${first.token}`).set('X-Tenant-Id', t.tenantId).expect(200)).body.deliveryCode;
    expect(otp).toBe(otpOf(id));
    const wrong = otp === '0000' ? '0001' : '0000';

    // Intento fallido con motivo y reintento.
    await setStatus(b, id, 'in_transit').expect(200);
    const failed = await setStatus(b, id, 'failed_attempt', { reason: 'Nadie en casa' }).expect(200);
    expect(failed.body).toMatchObject({ status: 'failed_attempt', attempts: 1 });
    const view = await request(server()).get(`/v1/tracking/${first.token}`).set('X-Tenant-Id', t.tenantId).expect(200);
    expect(view.body.events.at(-1)).toMatchObject({ status: 'failed_attempt', description: 'Nadie en casa' });
    expect(view.body.deliveryCode).toBe(otp);
    await setStatus(b, id, 'in_transit').expect(200);

    // Sin archivos (JSON) no hay forma de saltarse la prueba ni el código.
    const json = await request(server()).post(`/v1/rider/shipments/${id}/deliver`).set('Authorization', as(b)).send({ ...DEST, receiverName: 'Lucía', otp }).expect(422);
    expect(json.body.error.code).toBe('PROOF_PHOTO_REQUIRED');
    expect((await deliverMultipart(server(), as(b), id, { ...DEST, otp }, { signature: null }).expect(422)).body.error.code).toBe('PROOF_SIGNATURE_REQUIRED');
    expect((await deliverMultipart(server(), as(b), id, { ...DEST, otp }, { photo: Buffer.from('<html>x</html>') }).expect(422)).body.error.code).toBe('PROOF_PHOTO_TYPE');
    expect((await deliverMultipart(server(), as(b), id, { ...DEST, otp }, { signature: JPEG_TINY }).expect(422)).body.error.code).toBe('PROOF_SIGNATURE_TYPE');
    expect((await deliverMultipart(server(), as(b), id, { ...DEST }).expect(422)).body.error.code).toBe('OTP_REQUIRED');
    await deliverMultipart(server(), as(b), id, { ...DEST, otp: '12a4' }).expect(400);

    // 5 códigos incorrectos: 422 con los intentos que quedan; luego 423 aunque el código sea el correcto.
    for (const left of [4, 3, 2, 1, 0]) {
      const res = await deliverMultipart(server(), as(b), id, { ...DEST, otp: wrong }).expect(422);
      expect(res.body.error).toMatchObject({ code: 'OTP_INVALID', details: { attemptsLeft: left } });
    }
    expect((await deliverMultipart(server(), as(b), id, { ...DEST, otp }).expect(423)).body.error.code).toBe('OTP_LOCKED');
    const failures = await db.query(`SELECT 1 FROM logistics.delivery_proofs WHERE shipment_id = $1 AND proof_type = 'otp' AND otp_verified = false`, [id]);
    expect(failures.rowCount).toBe(5);
    expect((await request(server()).get(`/v1/rider/shipments/${id}`).set('Authorization', as(b)).expect(200)).body.status).toBe('in_transit');

    // Pasados 15 minutos se desbloquea.
    await db.query(`UPDATE logistics.delivery_proofs SET captured_at = captured_at - interval '16 minutes' WHERE shipment_id = $1`, [id]);
    const done = await deliverMultipart(server(), as(b), id, { ...DEST, otp }).expect(200);
    expect(done.body).toMatchObject({ id, status: 'delivered', deliveredAt: expect.any(String), attempts: 1 });
    expect((await orders.getOrder(t.tenantId, first.orderId)).status).toBe('delivered');

    // Pantalla posterior a la entrega; un motorizado ajeno no lo ve.
    expect((await request(server()).get(`/v1/rider/shipments/${id}`).set('Authorization', as(b)).expect(200)).body.status).toBe('delivered');
    await request(server()).get(`/v1/rider/shipments/${id}`).set('Authorization', as(a)).expect(404);
    expect((await request(server()).get(`/v1/tracking/${first.token}`).set('X-Tenant-Id', t.tenantId)).body.deliveryCode).toBeNull();

    // Backoffice: pruebas con enlace al archivo, servido inline y con nosniff.
    await request(server()).get(`/v1/logistics/shipments/${id}/proofs`).set('Authorization', staff([])).expect(403);
    const proofs = await request(server()).get(`/v1/logistics/shipments/${id}/proofs`).set('Authorization', staff(['logistics.read'])).expect(200);
    const types = proofs.body.map((p: { proofType: string; otpVerified: boolean | null }) => `${p.proofType}:${p.otpVerified}`).sort();
    expect(types).toEqual(['otp:false', 'otp:false', 'otp:false', 'otp:false', 'otp:false', 'otp:true', 'photo:null', 'signature:null']);
    const photo = proofs.body.find((p: { proofType: string }) => p.proofType === 'photo');
    expect(photo).toMatchObject({ receiverName: 'Lucía Torres', fileUrl: `/v1/logistics/proofs/${photo.id}/file`, distanceToDestinationM: expect.any(Number) });
    expect(proofs.body.find((p: { proofType: string; otpVerified: boolean }) => p.proofType === 'otp' && p.otpVerified).fileUrl).toBeNull();
    const file = await request(server()).get(photo.fileUrl).set('Authorization', staff(['logistics.read'])).buffer(true).expect(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['content-disposition']).toMatch(/^inline/);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(file.body as Buffer, JPEG_TINY)).toBe(0);
    const signature = proofs.body.find((p: { proofType: string }) => p.proofType === 'signature');
    const sig = await request(server()).get(signature.fileUrl).set('Authorization', staff(['logistics.read'])).buffer(true).expect(200);
    expect(sig.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(sig.body as Buffer, PNG_1X1)).toBe(0);
  });

  it('contra entrega: se cobra el monto exacto; con POS no suma al efectivo del motorizado', async () => {
    const s = await riderOrder({ cod: true });
    await request(server()).post(`/v1/logistics/shipments/${s.shipmentId}/assign`).set('Authorization', staff(['logistics.dispatch'])).send({ riderId: c.riderId }).expect(200);
    await setStatus(c, s.shipmentId, 'picked_up').expect(200);
    await setStatus(c, s.shipmentId, 'in_transit').expect(200);
    const otp = otpOf(s.shipmentId);

    const short = await deliverMultipart(server(), as(c), s.shipmentId, { ...DEST, otp, codCollected: '30.00' }).expect(422);
    expect(short.body.error).toMatchObject({ code: 'COD_AMOUNT_MISMATCH', details: { expected: '34.50', received: '30.00' } });
    expect((await deliverMultipart(server(), as(c), s.shipmentId, { ...DEST, otp }).expect(422)).body.error.code).toBe('COD_AMOUNT_MISMATCH');

    await deliverMultipart(server(), as(c), s.shipmentId, { ...DEST, otp, codCollected: '34.50', codMethod: 'card_pos' }).expect(200);
    const rider = await db.query<{ cod_balance: string }>(`SELECT cod_balance FROM logistics.riders WHERE id = $1`, [c.riderId]);
    expect(rider.rows[0].cod_balance).toBe('0.00');
    const row = await db.query(`SELECT cod_collected, cod_method FROM logistics.shipments WHERE id = $1`, [s.shipmentId]);
    expect(row.rows[0]).toEqual({ cod_collected: '34.50', cod_method: 'card_pos' });
  });

  it('fin de turno: no con envíos en curso; cancela y reofrece sus ofertas; resumen del turno', async () => {
    // C todavía tiene el envío asignado a mano.
    const busy = await request(server()).post('/v1/rider/shift/end').set('Authorization', as(c)).expect(409);
    expect(busy.body.error.code).toBe('SHIFT_HAS_ACTIVE_SHIPMENTS');

    // A recibe una oferta y termina el turno: se cancela y pasa a B.
    const s = await riderOrder({ status: 'ready_for_pickup' });
    const offered = await request(server()).post(`/v1/logistics/shipments/${s.shipmentId}/dispatch`).set('Authorization', staff(['logistics.dispatch'])).expect(200);
    expect(offered.body.riderId).toBe(a.riderId);
    const endA = await request(server()).post('/v1/rider/shift/end').set('Authorization', as(a)).expect(200);
    expect(endA.body).toEqual({
      shift: expect.objectContaining({ status: 'completed', endedAt: expect.any(String) }),
      summary: { deliveries: 0, fees: '0.00', codCollected: '0.00' },
    });
    const cancelled = await db.query(`SELECT response FROM logistics.dispatch_offers WHERE id = $1`, [offered.body.offerId]);
    expect(cancelled.rows[0].response).toBe('cancelled');
    expect((await request(server()).get('/v1/rider/me').set('Authorization', as(a))).body).toMatchObject({ presence: 'offline', shift: null });
    expect(await offersOf(b)).toEqual([expect.objectContaining({ shipmentId: s.shipmentId })]);
    expect((await request(server()).post('/v1/rider/shift/end').set('Authorization', as(a)).expect(409)).body.error.code).toBe('NO_ACTIVE_SHIFT');

    // B entregó un envío durante el turno.
    const endB = await request(server()).post('/v1/rider/shift/end').set('Authorization', as(b)).expect(200);
    expect(endB.body.summary).toEqual({ deliveries: 1, fees: '3.40', codCollected: '0.00' });
  });

  it('ganancias: semana en curso por defecto, efectivo por método y validación del rango', async () => {
    const earnB = await request(server()).get('/v1/rider/earnings').set('Authorization', as(b)).expect(200);
    expect(earnB.body).toMatchObject({
      deliveries: 1,
      fees: '3.40',
      bonusEstimate: '0.00',
      codCollected: { total: '0.00', cash: '0.00', card_pos: '0.00', deuna_qr: '0.00' },
      codBalance: '0.00',
      codLimit: '200.00',
      codAvailable: '200.00',
      today: { deliveries: 1, fees: '3.40' },
    });
    expect(earnB.body.items).toEqual([
      expect.objectContaining({ shipmentId: first.shipmentId, orderNumber: expect.stringMatching(/^\d+$/), fee: '3.40', distanceM: 3000, codAmount: '0.00', codMethod: null }),
    ]);
    expect(earnB.body.byDay.length).toBeGreaterThanOrEqual(1);
    expect(earnB.body.byDay.at(-1)).toMatchObject({ deliveries: 1, fees: '3.40' });

    const earnC = await request(server()).get('/v1/rider/earnings').set('Authorization', as(c)).expect(200);
    expect(earnC.body.codCollected).toEqual({ total: '34.50', cash: '0.00', card_pos: '34.50', deuna_qr: '0.00' });

    const long = await request(server()).get('/v1/rider/earnings?from=2026-01-01&to=2026-06-30').set('Authorization', as(b)).expect(422);
    expect(long.body.error.code).toBe('EARNINGS_RANGE_TOO_LONG');
    await request(server()).get('/v1/rider/earnings?from=ayer').set('Authorization', as(b)).expect(400);
  });
});
