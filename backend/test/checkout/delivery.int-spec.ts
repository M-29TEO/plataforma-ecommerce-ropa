import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Database, OutboxRelay } from '../../libs/shared-kernel';
import { getStock, tokenFor } from '../support/fixtures';
import {
  ADDRESS,
  countRows,
  createShop,
  createSlot,
  deliveryBody,
  GUAYAQUIL,
  guestCart,
  orderRow,
  postCheckout,
  postDeliveryOptions,
  Shop,
} from '../support/shop';
import { createTestApp } from '../support/test-app';

async function slotBooked(db: Database, slotId: string): Promise<number> {
  const { rows } = await db.query<{ booked: number }>(`SELECT booked FROM logistics.delivery_slots WHERE id = $1`, [slotId]);
  return rows[0].booked;
}

async function shipmentsOf(db: Database, orderId: string) {
  const { rows } = await db.query(`SELECT * FROM logistics.shipments WHERE order_id = $1`, [orderId]);
  return rows;
}

describe('Checkout con cotización de envío (Logística)', () => {
  let app: INestApplication;
  let db: Database;
  let relay: OutboxRelay;
  let shop: Shop;

  beforeAll(async () => {
    ({ app, db, relay } = await createTestApp({ withConsumers: true }));
    shop = await createShop(db, { blusa: 50, bolso: 20 });
  });

  afterAll(async () => {
    await app.close();
  });

  it('delivery-options: motorizado de la zona con sus franjas; el pedido guarda zona y franja, y queda el envío pendiente', async () => {
    const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 2 }]);
    const options = await postDeliveryOptions(app, shop.tenantId, { cookie }).expect(200);
    expect(options.body).toMatchObject({
      fulfillmentType: 'rider',
      reason: null,
      zone: { id: shop.zoneId },
      parcel: { weightG: 600, volumeCm3: 0, chargeableKg: 0.6 },
    });
    const [rider] = options.body.options;
    expect(rider).toMatchObject({ type: 'rider', price: '3.00', distanceSource: 'straight_line' });
    expect(rider.slots.map((s: { slotId: string }) => s.slotId)).toContain(shop.slotId);

    const before = await slotBooked(db, shop.slotId);
    const res = await postCheckout(app, shop.tenantId, { cookie }, {
      ...(await deliveryBody(app, shop.tenantId, { cookie })),
      deliveryQuoteId: rider.quoteId,
      deliverySlotId: shop.slotId,
      expectedTotal: '49.00',
    }).expect(201);
    expect(res.body.totals).toMatchObject({ shippingTotal: '3.00', total: '49.00' });
    expect(res.body.delivery).toMatchObject({ fulfillmentType: 'rider', zoneId: shop.zoneId, deliverySlotId: shop.slotId });

    expect(await orderRow(db, res.body.orderId)).toMatchObject({ shipping_zone_id: shop.zoneId, delivery_slot_id: shop.slotId, fulfillment_type: 'rider' });
    expect(await slotBooked(db, shop.slotId)).toBe(before + 1);
    const [shipment] = await shipmentsOf(db, res.body.orderId);
    expect(shipment).toMatchObject({
      id: res.body.delivery.shipmentId,
      status: 'pending',
      carrier_type: 'rider',
      zone_id: shop.zoneId,
      delivery_slot_id: shop.slotId,
      origin_warehouse_id: shop.warehouseId,
      weight_g: 600,
      price_charged: '3.00',
      cod_amount: '0.00',
    });
    expect(shipment.destination).toMatchObject({ mainStreet: ADDRESS.mainStreet, city: 'Quito', province: 'Pichincha' });
  });

  it('courier fuera de la zona: cotización del tarifario, quote marcada como elegida y envío con su servicio', async () => {
    const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.bolso, quantity: 1 }]);
    const body = await deliveryBody(app, shop.tenantId, { cookie }, { shippingAddress: GUAYAQUIL, paymentMethod: 'cod' });
    expect(body).toMatchObject({ fulfillmentType: 'courier' });
    const res = await postCheckout(app, shop.tenantId, { cookie }, body).expect(201);
    // 30.00 (IVA 0 %) + 5.50
    expect(res.body.totals).toMatchObject({ shippingTotal: '5.50', total: '35.50' });
    expect(res.body.delivery).toMatchObject({ fulfillmentType: 'courier', zoneId: null, deliverySlotId: null });

    const [shipment] = await shipmentsOf(db, res.body.orderId);
    expect(shipment).toMatchObject({ carrier_type: 'courier', courier_service_id: shop.courierServiceId, carrier_cost: '5.50', cod_amount: '35.50' });
    const { rows } = await db.query(`SELECT source, selected FROM logistics.courier_quotes WHERE shipment_id = $1`, [shipment.id]);
    expect(rows).toEqual([{ source: 'rate_card', selected: true }]);
  });

  it('dos clientes por el último cupo: uno compra y el otro recibe 409 sin que quede nada suyo', async () => {
    const lastSlot = await createSlot(db, shop.zoneId, 1, 30);
    const [a, b] = await Promise.all([1, 2].map(() => guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }])));
    const bodies = await Promise.all([a, b].map(async (cookie) => ({ ...(await deliveryBody(app, shop.tenantId, { cookie })), deliverySlotId: lastSlot })));
    const stockBefore = await getStock(db, shop.blusa, shop.warehouseId);

    const results = await Promise.all([postCheckout(app, shop.tenantId, { cookie: a }, bodies[0]), postCheckout(app, shop.tenantId, { cookie: b }, bodies[1])]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.error.code).toBe('SLOT_UNAVAILABLE');

    expect(await slotBooked(db, lastSlot)).toBe(1);
    // La reserva de stock del perdedor se revirtió con su transacción.
    expect((await getStock(db, shop.blusa, shop.warehouseId)).reserved).toBe(stockBefore.reserved + 1);
    expect(await countRows(db, `SELECT count(*) AS n FROM logistics.shipments WHERE delivery_slot_id = $1`, [lastSlot])).toBe(1);
  });

  it('cancelar el pedido devuelve el cupo de la franja (consumidor de OrderCancelled)', async () => {
    const cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
    const res = await postCheckout(app, shop.tenantId, { cookie }, await deliveryBody(app, shop.tenantId, { cookie })).expect(201);
    const slotId = res.body.delivery.deliverySlotId;
    const booked = await slotBooked(db, slotId);

    await request(app.getHttpServer())
      .post(`/v1/orders/${res.body.orderId}/status`)
      .set('Authorization', `Bearer ${tokenFor(shop, ['orders.cancel'])}`)
      .send({ to: 'cancelled', version: 0, reason: 'El cliente se arrepintió' })
      .expect(200);
    await relay.drain({ tenantId: shop.tenantId });

    expect(await slotBooked(db, slotId)).toBe(booked - 1);
    expect((await shipmentsOf(db, res.body.orderId))[0].status).toBe('cancelled');
  });

  describe('validaciones', () => {
    let cookie: string;
    beforeEach(async () => {
      cookie = await guestCart(app, shop.tenantId, [{ variantId: shop.blusa, quantity: 1 }]);
    });

    it('motorizado sin franja → 422 DELIVERY_SLOT_REQUIRED', async () => {
      const { deliverySlotId: _s, ...body } = await deliveryBody(app, shop.tenantId, { cookie });
      const res = await postCheckout(app, shop.tenantId, { cookie }, body).expect(422);
      expect(res.body.error.code).toBe('DELIVERY_SLOT_REQUIRED');
    });

    it('sin opción de envío → 400 (DTO); sin punto en el mapa → 422 SHIPPING_LOCATION_REQUIRED', async () => {
      const body = await deliveryBody(app, shop.tenantId, { cookie });
      const { deliveryQuoteId: _q, ...noQuote } = body;
      await postCheckout(app, shop.tenantId, { cookie }, noQuote).expect(400);
      const { lat: _lat, lng: _lng, ...noPoint } = ADDRESS;
      const res = await postCheckout(app, shop.tenantId, { cookie }, { ...body, shippingAddress: noPoint }).expect(422);
      expect(res.body.error.code).toBe('SHIPPING_LOCATION_REQUIRED');
    });

    it('el carrito cambió después de cotizar → 409 DELIVERY_QUOTE_MISMATCH', async () => {
      const body = await deliveryBody(app, shop.tenantId, { cookie });
      await request(app.getHttpServer())
        .post('/v1/cart/items')
        .set('X-Tenant-Id', shop.tenantId)
        .set('Cookie', `cart_token=${cookie}`)
        .send({ variantId: shop.bolso, quantity: 1 })
        .expect(200);
      const res = await postCheckout(app, shop.tenantId, { cookie }, body).expect(409);
      expect(res.body.error).toMatchObject({ code: 'DELIVERY_QUOTE_MISMATCH', details: { field: 'items' } });
    });

    it('otra dirección o tipo de entrega que el cotizado → 409; una cotización adulterada → 422', async () => {
      const body = await deliveryBody(app, shop.tenantId, { cookie });
      const moved = await postCheckout(app, shop.tenantId, { cookie }, { ...body, shippingAddress: { ...ADDRESS, lat: ADDRESS.lat + 0.001 } }).expect(409);
      expect(moved.body.error.details).toEqual({ field: 'shippingAddress' });
      const type = await postCheckout(app, shop.tenantId, { cookie }, { ...body, fulfillmentType: 'courier' }).expect(409);
      expect(type.body.error.details).toEqual({ field: 'fulfillmentType' });
      const forged = await postCheckout(app, shop.tenantId, { cookie }, { ...body, deliveryQuoteId: `${body.deliveryQuoteId}A` }).expect(422);
      expect(forged.body.error.code).toBe('INVALID_DELIVERY_QUOTE');
    });

    it('delivery-options sin lat/lng → 400', async () => {
      const { lat: _lat, lng: _lng, ...noPoint } = ADDRESS;
      await postDeliveryOptions(app, shop.tenantId, { cookie }, noPoint).expect(400);
    });
  });
});
