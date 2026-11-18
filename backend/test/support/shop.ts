/**
 * Helpers de los tests de Checkout y Pagos: una tienda con stock y logística (una zona con
 * motorizado alrededor de ADDRESS y un courier con tarifario), carritos de invitado o cliente,
 * cotización del envío y checkout por HTTP, y webhooks firmados como los envía la pasarela simulada.
 */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request, { Test } from 'supertest';
import { signWebhook } from '../../libs/modules/payments/infrastructure/simulator/paysim-signature';
import { Queryable } from '../../libs/shared-kernel';
import { createCustomer, createSellableVariant, createTenant, createWarehouse, customerTokenFor, setStock, TestTenant } from './fixtures';

export interface Shop extends TestTenant {
  warehouseId: string;
  /** Zona con motorizado ($3.00 fijo) que cubre ADDRESS, con una franja de mañana. */
  zoneId: string;
  slotId: string;
  courierServiceId: string;
  /** 20.00 + IVA 15 % */
  blusa: string;
  /** 30.00, IVA 0 % */
  bolso: string;
  customerId: string;
}

export async function createShop(db: Queryable, stock: { blusa?: number; bolso?: number } = {}): Promise<Shop> {
  const t = await createTenant(db);
  const warehouseId = await createWarehouse(db, t.tenantId);
  const blusa = (await createSellableVariant(db, t.tenantId, { price: '20.00', categoryPath: 'mujer/blusas', name: 'Blusa lino' })).variantId;
  const bolso = (await createSellableVariant(db, t.tenantId, { price: '30.00', taxCode: '0', categoryPath: 'accesorios/bolsos' })).variantId;
  await setStock(db, blusa, warehouseId, stock.blusa ?? 10);
  await setStock(db, bolso, warehouseId, stock.bolso ?? 5);
  const customerId = await createCustomer(db, t.tenantId);
  return { ...t, warehouseId, blusa, bolso, customerId, ...(await createDelivery(db, t.tenantId, warehouseId)) };
}

/**
 * Logística mínima de la tienda: zona "rider" de ~6 km de lado alrededor de ADDRESS con tarifa fija
 * $3.00 (fee_per_km 0, así el total no depende de la distancia), una franja de mañana con 100
 * cupos y el courier simulado con tarifario $5.50 a todo el país (el simulador no corre en los
 * tests: se cotiza con courier_rate_cards).
 */
export async function createDelivery(db: Queryable, tenantId: string, warehouseId: string) {
  const d = 0.03;
  const area = {
    type: 'Polygon',
    coordinates: [[
      [ADDRESS.lng - d, ADDRESS.lat - d],
      [ADDRESS.lng + d, ADDRESS.lat - d],
      [ADDRESS.lng + d, ADDRESS.lat + d],
      [ADDRESS.lng - d, ADDRESS.lat + d],
      [ADDRESS.lng - d, ADDRESS.lat - d],
    ]],
  };
  const zone = await db.query<{ id: string }>(
    `INSERT INTO logistics.coverage_zones (tenant_id, name, city, area, delivery_mode, base_fee, serving_warehouse_id)
     VALUES ($1, 'Zona de prueba', 'Quito', ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))::geography, 'rider', 3.00, $3)
     RETURNING id`,
    [tenantId, JSON.stringify(area), warehouseId],
  );
  const zoneId = zone.rows[0].id;
  const slotId = await createSlot(db, zoneId, 100);
  const courier = await db.query<{ id: string }>(
    `INSERT INTO logistics.couriers (tenant_id, code, name, adapter, secret_ref, supports_cod)
     VALUES ($1, 'simulador', 'Courier Simulado', 'simulator', 'env:COURIERSIM_SECRET', true) RETURNING id`,
    [tenantId],
  );
  const service = await db.query<{ id: string }>(
    `INSERT INTO logistics.courier_services (courier_id, code, name, max_weight_kg, sla_hours)
     VALUES ($1, 'ESTANDAR', 'Estándar', 30, 48) RETURNING id`,
    [courier.rows[0].id],
  );
  await db.query(
    `INSERT INTO logistics.courier_rate_cards (courier_service_id, origin_city, dest_province, weight_from_kg, weight_to_kg, price, valid_from)
     VALUES ($1, 'Quito', '*', 0, 30, 5.50, '2026-01-01')`,
    [service.rows[0].id],
  );
  return { zoneId, slotId, courierServiceId: service.rows[0].id };
}

/** Franja de mañana (cierra en 20 h) con la capacidad indicada. */
export async function createSlot(db: Queryable, zoneId: string, capacity: number, hoursAhead = 24): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO logistics.delivery_slots (zone_id, slot_date, starts_at, ends_at, capacity, cutoff_at)
     VALUES ($1, (now() + make_interval(hours => $2))::date, now() + make_interval(hours => $2),
             now() + make_interval(hours => $2 + 3), $3, now() + make_interval(hours => $2 - 4))
     RETURNING id`,
    [zoneId, hoursAhead, capacity],
  );
  return rows[0].id;
}

/** Carrito de invitado con los ítems; devuelve el token de la cookie httpOnly. */
export async function guestCart(app: INestApplication, tenantId: string, items: { variantId: string; quantity: number }[]): Promise<string> {
  let token: string | undefined;
  for (const item of items) {
    const req = request(app.getHttpServer()).post('/v1/cart/items').set('X-Tenant-Id', tenantId);
    if (token) req.set('Cookie', `cart_token=${token}`);
    const res = await req.send(item).expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('cart_token='));
    if (cookie) token = cookie.slice('cart_token='.length).split(';')[0];
  }
  if (!token) throw new Error('El carrito de invitado no devolvió cookie');
  return token;
}

export async function customerCart(app: INestApplication, shop: Shop, items: { variantId: string; quantity: number }[]): Promise<string> {
  const token = `Bearer ${customerTokenFor(shop.tenantId, shop.customerId)}`;
  for (const item of items) await request(app.getHttpServer()).post('/v1/cart/items').set('Authorization', token).send(item).expect(200);
  return token;
}

export const CUSTOMER = { name: 'Ana Pérez', email: 'ana@example.test', phone: '0991234567', idType: '05', idNumber: '1710034065' };
export const ADDRESS = { mainStreet: 'Av. Amazonas N34-45', secondaryStreet: 'Av. República', city: 'Quito', lat: -0.1807, lng: -78.4678 };
/** Fuera de toda zona propia: se entrega por courier. */
export const GUAYAQUIL = { mainStreet: 'Av. 9 de Octubre 100', city: 'Guayaquil', province: 'Guayas', lat: -2.1894, lng: -79.8891 };

export function checkoutBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { customer: CUSTOMER, fulfillmentType: 'rider', shippingAddress: ADDRESS, paymentMethod: 'card', ...overrides };
}

function withAuth(req: Test, tenantId: string, auth: { cookie?: string; bearer?: string }): Test {
  if (auth.bearer) req.set('Authorization', auth.bearer);
  else req.set('X-Tenant-Id', tenantId);
  if (auth.cookie) req.set('Cookie', `cart_token=${auth.cookie}`);
  return req;
}

/** POST /v1/checkout/delivery-options (sin verificar el estado: lo hace el test). */
export function postDeliveryOptions(app: INestApplication, tenantId: string, auth: { cookie?: string; bearer?: string }, address: Record<string, unknown> = ADDRESS) {
  return withAuth(request(app.getHttpServer()).post('/v1/checkout/delivery-options'), tenantId, auth).send({ shippingAddress: address });
}

/**
 * Cuerpo de checkout con el envío ya cotizado: pide las opciones para la dirección
 * (overrides.shippingAddress o ADDRESS) y elige la primera (y su primera franja, si es motorizado).
 */
export async function deliveryBody(
  app: INestApplication,
  tenantId: string,
  auth: { cookie?: string; bearer?: string },
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const address = (overrides.shippingAddress as Record<string, unknown> | undefined) ?? ADDRESS;
  const res = await postDeliveryOptions(app, tenantId, auth, address);
  if (res.status !== 200) throw new Error(`delivery-options respondió ${res.status}: ${JSON.stringify(res.body)}`);
  const option = res.body.options[0];
  return checkoutBody({
    fulfillmentType: res.body.fulfillmentType,
    shippingAddress: address,
    deliveryQuoteId: option.quoteId,
    ...(option.slots ? { deliverySlotId: option.slots[0].slotId } : {}),
    ...overrides,
  });
}

/** POST /v1/checkout como invitado (cookie) o cliente (Bearer). */
export function postCheckout(
  app: INestApplication,
  tenantId: string,
  auth: { cookie?: string; bearer?: string },
  body: Record<string, unknown>,
  key: string | null = randomUUID(),
) {
  const req = withAuth(request(app.getHttpServer()).post('/v1/checkout'), tenantId, auth);
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
}

export interface PaysimEventInput {
  id?: string;
  type: 'payment.approved' | 'payment.rejected';
  reference: string;
  amount: string;
  failureCode?: string;
  failureMessage?: string;
}

/** Cuerpo del webhook tal como lo arma simulators/payments/server.mjs. */
export function paysimEvent(e: PaysimEventInput): string {
  const approved = e.type === 'payment.approved';
  return JSON.stringify({
    id: e.id ?? `evt_${randomUUID().replace(/-/g, '')}`,
    type: e.type,
    created: Math.floor(Date.now() / 1000),
    data: {
      reference: e.reference,
      amount: e.amount,
      currency: 'USD',
      method: 'card',
      ...(approved
        ? { authorizationCode: '654321', cardBrand: 'visa', last4: '4242' }
        : { failureCode: e.failureCode ?? 'INSUFFICIENT_FUNDS', failureMessage: e.failureMessage ?? 'Fondos insuficientes' }),
    },
  });
}

/** POST del webhook con firma HMAC (por defecto válida con PAYSIM_SECRET). */
export function postWebhook(app: INestApplication, body: string, opts: { secret?: string; timestamp?: number; signature?: string | null } = {}): Test {
  const secret = opts.secret ?? process.env.PAYSIM_SECRET!;
  const req = request(app.getHttpServer()).post('/v1/webhooks/payments/simulator').set('Content-Type', 'application/json');
  const signature = opts.signature === undefined ? signWebhook(secret, body, opts.timestamp) : opts.signature;
  if (signature !== null) req.set('X-Paysim-Signature', signature);
  return req.send(body);
}

/** La referencia de la pasarela viaja en la URL de redirección (ref=ps_...). */
export function referenceFrom(redirectUrl: string): string {
  const ref = new URL(redirectUrl).searchParams.get('ref');
  if (!ref) throw new Error(`URL sin ref: ${redirectUrl}`);
  return ref;
}

export async function paymentRow(db: Queryable, paymentId: string) {
  const { rows } = await db.query(`SELECT * FROM payments.payments WHERE id = $1`, [paymentId]);
  return rows[0];
}

export async function orderRow(db: Queryable, orderId: string) {
  const { rows } = await db.query(`SELECT * FROM sales.orders WHERE id = $1`, [orderId]);
  return rows[0];
}

export async function reservations(db: Queryable, orderId: string) {
  const { rows } = await db.query<{ status: string; quantity: number; expires_at: Date }>(
    `SELECT status, quantity, expires_at FROM inventory.stock_reservations WHERE order_id = $1 ORDER BY variant_id`,
    [orderId],
  );
  return rows;
}

/** Cantidades de stock_levels sin la columna version (que sube en cada UPDATE). */
export async function stockQty(db: Queryable, variantId: string, warehouseId: string) {
  const { rows } = await db.query<{ on_hand: number; reserved: number; available: number }>(
    `SELECT on_hand, reserved, available FROM inventory.stock_levels WHERE variant_id = $1 AND warehouse_id = $2`,
    [variantId, warehouseId],
  );
  return rows[0];
}

export async function countRows(db: Queryable, sql: string, values: unknown[]): Promise<number> {
  const { rows } = await db.query<{ n: number }>(sql, values);
  return Number(rows[0].n);
}
