import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { RealtimeModule, ValkeyIoAdapter } from '../../apps/realtime/realtime.module';
import { findSystemRole } from '../../libs/modules/iam/domain/system-roles';
import { NewOrder, OrdersApi } from '../../libs/modules/orders';
import { APP_CONFIG, AppConfig, AuthUser, Database, signAccessToken } from '../../libs/shared-kernel';
import { createCustomer, createRider, createSellableVariant, createTenant, createWarehouse, riderTokenFor, TestTenant } from '../support/fixtures';
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

/** Cuenta los eventos que llegan en una ventana (para probar que otro tenant no recibe nada). */
function collect(socket: Socket, event: string): unknown[] {
  const got: unknown[] = [];
  socket.on(event, (d: unknown) => got.push(d));
  return got;
}

/**
 * Backoffice de logística: mapa en vivo (GET /logistics/riders/live), cola de despacho
 * (GET /logistics/shipments) y Socket.IO del staff (namespace /staff, sala riders:{tenantId}).
 */
describe('Logística en vivo para el backoffice (integración)', () => {
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
  let idleRider: { riderId: string; userId: string };
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
    idleRider = await createRider(db, t.tenantId);
    await db.query(`UPDATE iam.users SET first_name = 'Mateo', last_name = 'Paredes', phone = '0991234567' WHERE id = $1`, [rider.userId]);
    await db.query(`UPDATE logistics.riders SET plate = 'PBA-1234' WHERE id = $1`, [rider.riderId]);
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await rt.close();
    await app.close();
  });

  const server = () => app.getHttpServer();
  const staffToken = (permissions: readonly string[], opts: { tenantId?: string; type?: AuthUser['type']; expiresIn?: number } = {}) =>
    signAccessToken(
      { id: t.userId, tenantId: opts.tenantId ?? t.tenantId, type: opts.type ?? 'staff', permissions: [...permissions] },
      process.env.JWT_SECRET!,
      opts.expiresIn,
    );
  const logistics = () => `Bearer ${staffToken(findSystemRole('logistics')!.permissions)}`;
  const seller = () => `Bearer ${staffToken(findSystemRole('seller')!.permissions)}`;
  const asRider = (r = rider) => `Bearer ${riderTokenFor(t.tenantId, r.userId)}`;
  const connectStaff = (accessToken: unknown) => {
    const s = io(`${rtUrl}/staff`, { path: '/ws/socket.io', auth: { accessToken }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    return s;
  };

  /** Pedido pagado con su envío pendiente con motorizado (lo que deja el checkout). */
  async function riderOrder(): Promise<{ orderId: string; shipmentId: string }> {
    const input: NewOrder = {
      id: randomUUID(),
      tenantId: t.tenantId,
      userId: customerId,
      customer: { name: 'Lucía Torres', email: 'lucia@example.test' },
      billing: {},
      paymentMethod: 'card',
      fulfillmentType: 'rider',
      shippingAddress: { mainStreet: 'Av. Amazonas', secondaryStreet: 'Naciones Unidas', reference: 'Casa azul', city: 'Quito' },
      shippingLocation: DEST,
      shippingCity: 'Quito',
      sourceWarehouseId: warehouseId,
      items: [{ ...product, sku: `SKU-${randomUUID().slice(0, 6)}`, productName: 'Chaqueta', quantity: 1, unitPrice: '30.00', taxCode: '4', taxRate: '15.00', warehouseId }],
    };
    const o = await orders.placeOrder(input);
    await orders.markPaid(t.tenantId, o.id);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO logistics.shipments (tenant_id, order_id, carrier_type, tracking_token, status, origin_warehouse_id, destination,
                                        destination_location, weight_g)
       VALUES ($1, $2, 'rider', $3, 'pending', $4, $5::jsonb, ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography, 800) RETURNING id`,
      [t.tenantId, o.id, randomBytes(18).toString('base64url'), warehouseId, JSON.stringify(input.shippingAddress), DEST.lng, DEST.lat],
    );
    return { orderId: o.id, shipmentId: rows[0].id };
  }

  it('mapa en vivo: motorizados con nombre (IAM), última posición y envíos en curso; seller sin acceso', async () => {
    const { orderId, shipmentId } = await riderOrder();
    await request(server()).post(`/v1/logistics/shipments/${shipmentId}/assign`).set('Authorization', logistics()).send({ riderId: rider.riderId }).expect(200);
    await request(server()).post(`/v1/rider/shipments/${shipmentId}/status`).set('Authorization', asRider()).send({ status: 'picked_up' }).expect(200);
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await request(server()).post('/v1/rider/location').set('Authorization', asRider()).send({ lat: -0.16, lng: -78.48, recordedAt: old }).expect(202);
    await request(server()).post('/v1/rider/location').set('Authorization', asRider()).send({ ...FAR, heading: 90, speedKmh: 25 }).expect(202);

    await request(server()).get('/v1/logistics/riders/live').set('Authorization', seller()).expect(403);
    await request(server()).get('/v1/logistics/riders/live').expect(401);

    const res = await request(server()).get('/v1/logistics/riders/live').set('Authorization', logistics()).expect(200);
    expect(res.body).toHaveLength(2);
    const mine = res.body.find((r: { riderId: string }) => r.riderId === rider.riderId);
    expect(mine).toEqual({
      riderId: rider.riderId,
      userId: rider.userId,
      name: 'Mateo Paredes',
      phone: '0991234567',
      vehicleType: 'motorcycle',
      plate: 'PBA-1234',
      status: 'active',
      presence: 'offline',
      codBalance: '0.00',
      codLimit: '200.00',
      ratingAvg: '5.00',
      lastLocation: { ...FAR, heading: 90, speedKmh: 25, recordedAt: expect.any(String) },
      activeShipments: [{ shipmentId, orderId, status: 'picked_up', dropoff: DEST }],
    });
    // Sin nombre en IAM se muestra el email; sin posiciones, null.
    const idle = res.body.find((r: { riderId: string }) => r.riderId === idleRider.riderId);
    expect(idle).toMatchObject({ name: expect.stringMatching(/^moto\+.*@example\.test$/), phone: null, lastLocation: null, activeShipments: [] });

    // Otro tenant no ve esta flota.
    const other = await createTenant(db);
    const foreign = await request(server())
      .get('/v1/logistics/riders/live')
      .set('Authorization', `Bearer ${staffToken(['logistics.read'], { tenantId: other.tenantId })}`)
      .expect(200);
    expect(foreign.body).toEqual([]);
  });

  it('cola de despacho: filtra por estado, pagina con total y valida el filtro', async () => {
    const a = await riderOrder();
    const b = await riderOrder();
    const res = await request(server()).get('/v1/logistics/shipments?status=pending,ready_for_pickup&limit=100').set('Authorization', logistics()).expect(200);
    const ids = res.body.items.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining([a.shipmentId, b.shipmentId]));
    expect(ids.indexOf(a.shipmentId)).toBeLessThan(ids.indexOf(b.shipmentId));
    expect(res.body.total).toBe(res.body.items.length);
    expect(res.body.items.find((s: { id: string }) => s.id === a.shipmentId)).toEqual({
      id: a.shipmentId,
      orderId: a.orderId,
      direction: 'outbound',
      carrierType: 'rider',
      status: 'pending',
      zoneId: null,
      riderId: null,
      codAmount: '0.00',
      slot: null,
      createdAt: expect.any(String),
      destinationLabel: 'Av. Amazonas y Naciones Unidas, Quito',
      dropoff: DEST,
    });

    const page = await request(server()).get('/v1/logistics/shipments?status=pending&limit=1&offset=1').set('Authorization', logistics()).expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.total).toBeGreaterThanOrEqual(2);
    const beyond = await request(server()).get('/v1/logistics/shipments?status=pending&limit=1&offset=500').set('Authorization', logistics()).expect(200);
    expect(beyond.body).toEqual({ items: [], total: page.body.total });

    const assigned = await request(server()).get(`/v1/logistics/shipments?status=picked_up&riderId=${rider.riderId}`).set('Authorization', logistics()).expect(200);
    expect(assigned.body.items.every((s: { status: string; riderId: string }) => s.status === 'picked_up' && s.riderId === rider.riderId)).toBe(true);

    await request(server()).get('/v1/logistics/shipments?status=volando').set('Authorization', logistics()).expect(400);
    await request(server()).get('/v1/logistics/shipments').set('Authorization', seller()).expect(403);
  });

  it('socket del staff: sala riders:{tenantId} con posición, estado y presencia; otro tenant no recibe nada', async () => {
    const live = connectStaff(staffToken(['logistics.read']));
    expect(await once(live, 'staff.ready')).toMatchObject({ tenantId: t.tenantId, expiresAt: expect.any(String) });
    const other = await createTenant(db);
    const foreign = connectStaff(staffToken(['logistics.read'], { tenantId: other.tenantId }));
    await once(foreign, 'staff.ready');
    const leaked = collect(foreign, 'rider.location');

    const { orderId, shipmentId } = await riderOrder();
    const statusEvt = once(live, 'shipment.status');
    await request(server()).post(`/v1/logistics/shipments/${shipmentId}/assign`).set('Authorization', logistics()).send({ riderId: rider.riderId }).expect(200);
    expect(await statusEvt).toEqual({ shipmentId, orderId, riderId: rider.riderId, status: 'assigned' });

    const locEvt = once(live, 'rider.location');
    await request(server()).post('/v1/rider/location').set('Authorization', asRider()).send({ ...DEST, heading: 10, speedKmh: 12.5 }).expect(202);
    expect(await locEvt).toEqual({ riderId: rider.riderId, ...DEST, heading: 10, speedKmh: 12.5, recordedAt: expect.any(String), shipmentId: expect.any(String) });

    const presenceEvt = once(live, 'rider.presence');
    const p = await request(server()).post('/v1/rider/presence').set('Authorization', asRider(idleRider)).send({ presence: 'available' }).expect(200);
    expect(p.body).toEqual({ riderId: idleRider.riderId, presence: 'available' });
    expect(await presenceEvt).toEqual({ riderId: idleRider.riderId, presence: 'available', changedAt: expect.any(String) });
    await request(server()).post('/v1/rider/presence').set('Authorization', asRider(idleRider)).send({ presence: 'volando' }).expect(400);
    await request(server()).post('/v1/rider/presence').set('Authorization', logistics()).send({ presence: 'available' }).expect(403);

    await new Promise((r) => setTimeout(r, 300));
    expect(leaked).toEqual([]);
  });

  it('socket del staff: rechaza tokens inválidos, sin permiso o de cliente, y corta al vencer el token', async () => {
    expect(await once(connectStaff('no-es-un-jwt'), 'staff.error')).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await once(connectStaff(undefined), 'staff.error')).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await once(connectStaff(staffToken(['logistics.read'], { expiresIn: -10 })), 'staff.error')).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await once(connectStaff(staffToken(findSystemRole('seller')!.permissions)), 'staff.error')).toMatchObject({ code: 'FORBIDDEN' });
    expect(await once(connectStaff(staffToken(['logistics.read'], { type: 'customer' })), 'staff.error')).toMatchObject({ code: 'FORBIDDEN' });
    const forged = signAccessToken({ id: t.userId, tenantId: t.tenantId, type: 'staff', permissions: ['logistics.read'] }, 'otro-secreto-que-no-es-el-de-la-api');
    expect(await once(connectStaff(forged), 'staff.error')).toMatchObject({ code: 'UNAUTHORIZED' });

    // El public namespace (tracking) sigue igual: sin trackingToken se rechaza con su propio evento.
    const pub = io(rtUrl, { path: '/ws/socket.io', auth: { accessToken: staffToken(['logistics.read']) }, transports: ['websocket'], reconnection: false });
    sockets.push(pub);
    expect(await once(pub, 'tracking.error')).toMatchObject({ code: 'TRACKING_NOT_FOUND' });

    // Token que vence en 2 s: entra y luego lo desconectan con TOKEN_EXPIRED.
    const short = connectStaff(staffToken(['logistics.read'], { expiresIn: 2 }));
    await once(short, 'staff.ready');
    const disconnected = once<string>(short, 'disconnect', 6000);
    expect(await once(short, 'staff.error', 6000)).toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(await disconnected).toBe('io server disconnect');
  });
});
