import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { RealtimeModule, ValkeyIoAdapter } from '../../apps/realtime/realtime.module';
import { deliveryOtpCode } from '../../libs/modules/logistics/domain/delivery-proof';
import { NewOrder, OrdersApi } from '../../libs/modules/orders';
import { APP_CONFIG, AppConfig, Database, signAccessToken } from '../../libs/shared-kernel';
import { createCustomer, createRider, createSellableVariant, createTenant, createWarehouse, customerTokenFor, outboxEvents, riderTokenFor, TestTenant } from '../support/fixtures';
import { deliverMultipart } from '../support/rider';
import { createTestApp } from '../support/test-app';

/** Destino en Quito (La Carolina) y un punto ~1,3 km al sur. */
const DEST = { lat: -0.1765, lng: -78.4844 };
const FAR = { lat: -0.188, lng: -78.4844 };

function once<T = Record<string, unknown>>(socket: Socket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No llegó ${event}`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Asignación, estados, posiciones y entrega de un envío con motorizado, con el seguimiento público
 * por HTTP y en vivo por Socket.IO (proceso realtime real con el adaptador de Valkey).
 */
describe('Tracking del motorizado (integración)', () => {
  let app: INestApplication;
  let rt: INestApplication;
  let rtUrl: string;
  let db: Database;
  let orders: OrdersApi;
  let t: TestTenant;
  let warehouseId: string;
  let product: { productId: string; variantId: string };
  let customerId: string;
  let rider: { riderId: string; userId: string };
  let otherRider: { riderId: string; userId: string };
  const sockets: Socket[] = [];

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    orders = app.get(OrdersApi);

    const rtRef = await Test.createTestingModule({ imports: [RealtimeModule] }).compile();
    rt = rtRef.createNestApplication({ logger: ['error', 'warn'] });
    const adapter = new ValkeyIoAdapter(rt, rt.get<AppConfig>(APP_CONFIG));
    await adapter.connect();
    rt.useWebSocketAdapter(adapter);
    await rt.listen(0, '127.0.0.1');
    rtUrl = `http://127.0.0.1:${(rt.getHttpServer().address() as AddressInfo).port}`;

    t = await createTenant(db);
    warehouseId = await createWarehouse(db, t.tenantId, { lat: -0.15, lng: -78.485 });
    product = await createSellableVariant(db, t.tenantId, { price: '30.00', name: 'Chaqueta' });
    customerId = await createCustomer(db, t.tenantId);
    rider = await createRider(db, t.tenantId);
    otherRider = await createRider(db, t.tenantId);
    await db.query(`UPDATE logistics.riders SET plate = 'PBA-1234' WHERE id = $1`, [rider.riderId]);
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await rt.close();
    await app.close();
  });

  const server = () => app.getHttpServer();
  const staff = (permissions: string[]) =>
    `Bearer ${signAccessToken({ id: t.userId, tenantId: t.tenantId, type: 'staff', permissions }, process.env.JWT_SECRET!)}`;
  const asRider = (r = rider) => `Bearer ${riderTokenFor(t.tenantId, r.userId)}`;
  const connect = (trackingToken: string) => {
    const s = io(rtUrl, { path: '/ws/socket.io', auth: { trackingToken }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    return s;
  };

  /** Pedido pagado con su envío pendiente con motorizado (lo que deja el checkout). */
  async function riderOrder(opts: { cod?: boolean } = {}): Promise<{ orderId: string; shipmentId: string; token: string }> {
    const input: NewOrder = {
      id: randomUUID(),
      tenantId: t.tenantId,
      userId: customerId,
      customer: { name: 'Lucía Torres', email: 'lucia@example.test' },
      billing: {},
      paymentMethod: opts.cod ? 'cod' : 'card',
      fulfillmentType: 'rider',
      shippingAddress: { mainStreet: 'Av. Amazonas', secondaryStreet: 'Naciones Unidas', reference: 'Casa azul, timbre 3', city: 'Quito' },
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
                                        destination_location, weight_g, cod_amount)
       VALUES ($1, $2, 'rider', $3, 'pending', $4, $5::jsonb, ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography, 800, $8) RETURNING id`,
      [t.tenantId, o.id, token, warehouseId, JSON.stringify(input.shippingAddress), DEST.lng, DEST.lat, opts.cod ? '34.50' : '0'],
    );
    return { orderId: o.id, shipmentId: rows[0].id, token };
  }

  it('entrega completa: asignar, retirar, posiciones en vivo, en camino y entregar cerca del destino', async () => {
    const { orderId, shipmentId, token } = await riderOrder();

    // Sin el permiso de despacho no se asigna.
    await request(server()).post(`/v1/logistics/shipments/${shipmentId}/assign`).set('Authorization', staff(['logistics.read'])).send({ riderId: rider.riderId }).expect(403);

    // El cliente abre el seguimiento en vivo antes de que salga el pedido.
    const live = connect(token);
    expect(await once(live, 'tracking.ready')).toMatchObject({ shipmentId, status: 'pending' });

    const statusAssigned = once(live, 'shipment.status');
    const assigned = await request(server())
      .post(`/v1/logistics/shipments/${shipmentId}/assign`)
      .set('Authorization', staff(['logistics.dispatch']))
      .send({ riderId: rider.riderId })
      .expect(200);
    expect(assigned.body).toMatchObject({ status: 'assigned', riderId: rider.riderId });
    expect(await statusAssigned).toMatchObject({ shipmentId, status: 'assigned', description: 'Motorizado asignado' });
    expect((await orders.getOrder(t.tenantId, orderId)).status).toBe('preparing');

    // El motorizado ve su envío; otro motorizado no puede tocarlo.
    const mine = await request(server()).get('/v1/rider/shipments').set('Authorization', asRider()).expect(200);
    expect(mine.body).toEqual([expect.objectContaining({ id: shipmentId, status: 'assigned', destination: expect.objectContaining({ location: DEST }) })]);
    await request(server()).post(`/v1/rider/shipments/${shipmentId}/status`).set('Authorization', asRider(otherRider)).send({ status: 'picked_up' }).expect(404);
    // Un cliente no usa las rutas del motorizado.
    await request(server()).get('/v1/rider/shipments').set('Authorization', `Bearer ${customerTokenFor(t.tenantId, customerId)}`).expect(403);

    // Antes de retirar, la posición no se publica al cliente.
    const idle = await request(server()).post('/v1/rider/location').set('Authorization', asRider()).send({ lat: -0.15, lng: -78.485 }).expect(202);
    expect(idle.body).toEqual({ recorded: 1, liveShipments: [], openOffers: 0 });

    const pickedUp = once(live, 'shipment.status');
    await request(server()).post(`/v1/rider/shipments/${shipmentId}/status`).set('Authorization', asRider()).send({ status: 'picked_up', lat: -0.15, lng: -78.485 }).expect(200);
    expect(await pickedUp).toMatchObject({ status: 'picked_up' });
    expect((await orders.getOrder(t.tenantId, orderId)).status).toBe('shipped');
    // No se salta estados: de retirado no pasa directo a llegando.
    await request(server()).post(`/v1/rider/shipments/${shipmentId}/status`).set('Authorization', asRider()).send({ status: 'arriving' }).expect(409);

    const location = once<{ lat: number; lng: number; etaSeconds: number; heading: number }>(live, 'rider.location');
    const moved = await request(server()).post('/v1/rider/location').set('Authorization', asRider()).send({ ...FAR, heading: 0, speedKmh: 28.5 }).expect(202);
    expect(moved.body).toEqual({ recorded: 1, liveShipments: [shipmentId], openOffers: 0 });
    const pos = await location;
    expect(pos).toMatchObject({ shipmentId, ...FAR, heading: 0 });
    // Sin OSRM: línea recta (~1,28 km × 1,3) a 22 km/h ≈ 270 s.
    expect(pos.etaSeconds).toBeGreaterThan(240);
    expect(pos.etaSeconds).toBeLessThan(300);

    // Seguimiento público por HTTP: posición, motorizado sin datos personales, destino sin referencia.
    const view = await request(server()).get(`/v1/tracking/${token}`).set('X-Tenant-Id', t.tenantId).expect(200);
    expect(view.body).toMatchObject({
      status: 'picked_up',
      carrierType: 'rider',
      destination: { label: 'Av. Amazonas y Naciones Unidas, Quito', location: DEST },
      origin: { name: 'Bodega de prueba', location: { lat: -0.15, lng: -78.485 } },
      rider: { vehicleType: 'motorcycle', plate: 'PBA-1234', ratingAvg: '5.00' },
      riderPosition: { ...FAR, heading: 0, speedKmh: 28.5 },
      deliveredAt: null,
    });
    // Código de entrega que el cliente dicta al motorizado (solo mientras va en camino).
    expect(view.body.deliveryCode).toMatch(/^\d{4}$/);
    const otp: string = view.body.deliveryCode;
    expect(view.body.orderNumber).toMatch(/^\d+$/);
    expect(view.body.events.map((e: { status: string }) => e.status)).toEqual(['assigned', 'picked_up']);
    expect(new Date(view.body.eta).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(view.body)).not.toMatch(/timbre|lucia|Lucía/);
    // Con el header de otro tenant, no existe.
    const other = await createTenant(db);
    await request(server()).get(`/v1/tracking/${token}`).set('X-Tenant-Id', other.tenantId).expect(404);

    await request(server()).post(`/v1/rider/shipments/${shipmentId}/status`).set('Authorization', asRider()).send({ status: 'in_transit' }).expect(200);
    expect((await orders.getOrder(t.tenantId, orderId)).status).toBe('in_transit');

    // Lejos del destino no se puede marcar entregado.
    const far = await deliverMultipart(server(), asRider(), shipmentId, { ...FAR, otp }).expect(422);
    expect(far.body.error.code).toBe('DELIVERY_TOO_FAR');

    const delivered = once(live, 'shipment.status');
    const done = await deliverMultipart(server(), asRider(), shipmentId, { lat: DEST.lat + 0.0005, lng: DEST.lng, otp }).expect(200);
    expect(done.body).toMatchObject({ id: shipmentId, status: 'delivered', requiresOtp: true });
    expect(await delivered).toMatchObject({ status: 'delivered', description: 'Entregado' });
    expect((await orders.getOrder(t.tenantId, orderId)).status).toBe('delivered');

    const proof = await db.query<{ proof_type: string; receiver_name: string | null; distance_to_destination_m: number }>(
      `SELECT proof_type, receiver_name, distance_to_destination_m FROM logistics.delivery_proofs WHERE shipment_id = $1 ORDER BY proof_type`,
      [shipmentId],
    );
    expect(proof.rows).toEqual([
      { proof_type: 'otp', receiver_name: null, distance_to_destination_m: expect.any(Number) },
      { proof_type: 'photo', receiver_name: 'Lucía Torres', distance_to_destination_m: expect.any(Number) },
      { proof_type: 'signature', receiver_name: 'Lucía Torres', distance_to_destination_m: expect.any(Number) },
    ]);
    expect(proof.rows[0].distance_to_destination_m).toBeLessThan(100);

    const after = await request(server()).get(`/v1/tracking/${token}`).set('X-Tenant-Id', t.tenantId).expect(200);
    expect(after.body).toMatchObject({ status: 'delivered', riderPosition: null, eta: null, deliveryCode: null });
    expect(after.body.deliveredAt).not.toBeNull();
    expect(after.body.events.map((e: { status: string }) => e.status)).toEqual(['assigned', 'picked_up', 'in_transit', 'delivered']);

    // Cada cambio de estado queda en el outbox para Notificaciones.
    const events = (await outboxEvents(db, t.tenantId, 'ShipmentStatusChanged')).filter((e) => e.aggregate_id === shipmentId);
    expect(events.map((e) => e.payload.status)).toEqual(['assigned', 'picked_up', 'in_transit', 'delivered']);
    expect(events[0].payload).toMatchObject({ trackingToken: token, previousStatus: 'pending', direction: 'outbound' });

    // Ya entregado: el motorizado no tiene envíos activos.
    expect((await request(server()).get('/v1/rider/shipments').set('Authorization', asRider()).expect(200)).body).toEqual([]);
  });

  it('contra entrega: el tope de efectivo bloquea la asignación y la entrega suma al saldo del motorizado', async () => {
    const { shipmentId } = await riderOrder({ cod: true });
    await db.query(`UPDATE logistics.riders SET cod_balance = 180, cod_limit = 200 WHERE id = $1`, [otherRider.riderId]);
    const blocked = await request(server())
      .post(`/v1/logistics/shipments/${shipmentId}/assign`)
      .set('Authorization', staff(['logistics.dispatch']))
      .send({ riderId: otherRider.riderId })
      .expect(409);
    expect(blocked.body.error.code).toBe('RIDER_COD_LIMIT');

    await request(server()).post(`/v1/logistics/shipments/${shipmentId}/assign`).set('Authorization', staff(['logistics.dispatch'])).send({ riderId: rider.riderId }).expect(200);
    for (const status of ['picked_up', 'in_transit', 'arriving']) {
      await request(server()).post(`/v1/rider/shipments/${shipmentId}/status`).set('Authorization', asRider()).send({ status }).expect(200);
    }
    const before = await db.query<{ cod_balance: string }>(`SELECT cod_balance FROM logistics.riders WHERE id = $1`, [rider.riderId]);
    const otp = deliveryOtpCode(app.get<AppConfig>(APP_CONFIG).logistics.deliveryOtpSecret, shipmentId);
    await deliverMultipart(server(), asRider(), shipmentId, { ...DEST, otp, codCollected: '34.50' }).expect(200);
    const after = await db.query<{ cod_balance: string }>(`SELECT cod_balance FROM logistics.riders WHERE id = $1`, [rider.riderId]);
    expect(Number(after.rows[0].cod_balance) - Number(before.rows[0].cod_balance)).toBeCloseTo(34.5);
    const s = await db.query<{ cod_collected: string; cod_method: string }>(`SELECT cod_collected, cod_method FROM logistics.shipments WHERE id = $1`, [shipmentId]);
    expect(s.rows[0]).toEqual({ cod_collected: '34.50', cod_method: 'cash' });
  });

  it('mis pedidos enlaza al seguimiento; un pedido ajeno no existe', async () => {
    const { orderId, token } = await riderOrder();
    const res = await request(server()).get(`/v1/me/orders/${orderId}/shipments`).set('Authorization', `Bearer ${customerTokenFor(t.tenantId, customerId)}`).expect(200);
    expect(res.body).toEqual([expect.objectContaining({ trackingToken: token, carrierType: 'rider', status: 'pending', direction: 'outbound' })]);

    const stranger = await createCustomer(db, t.tenantId);
    await request(server()).get(`/v1/me/orders/${orderId}/shipments`).set('Authorization', `Bearer ${customerTokenFor(t.tenantId, stranger)}`).expect(404);
  });

  it('valida posiciones y tokens', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const stale = await request(server()).post('/v1/rider/location').set('Authorization', asRider()).send({ lat: -0.18, lng: -78.48, recordedAt: old }).expect(422);
    expect(stale.body.error.code).toBe('POSITION_OUT_OF_RANGE');
    await request(server()).post('/v1/rider/location').set('Authorization', asRider()).send({ lat: 95, lng: -78.48 }).expect(400);

    await request(server()).get('/v1/tracking/no-existe-este-token-xx').set('X-Tenant-Id', t.tenantId).expect(404);
    await request(server()).get('/v1/tracking/corto').set('X-Tenant-Id', t.tenantId).expect(400);

    const bad = connect('token-que-no-existe-0000');
    expect(await once(bad, 'tracking.error')).toMatchObject({ code: 'TRACKING_NOT_FOUND' });
  });
});
