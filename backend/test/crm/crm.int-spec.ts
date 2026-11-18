import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
// Internos: el test llama a los jobs (puntos, referidos, wishlist) con un "ahora" controlado.
import { LoyaltyService } from '../../libs/modules/crm/application/loyalty.service';
import { ReferralService } from '../../libs/modules/crm/application/referral.service';
import { WishlistService } from '../../libs/modules/crm/application/wishlist.service';
import { CrmApi } from '../../libs/modules/crm';
import { NewOrder, OrdersApi } from '../../libs/modules/orders';
import { Database, OutboxRelay, signAccessToken } from '../../libs/shared-kernel';
import {
  createCustomer,
  createSellableVariant,
  createTenant,
  createWarehouse,
  customerTokenFor,
  outboxEvents,
  setStock,
  TestTenant,
} from '../support/fixtures';
import { createTestApp } from '../support/test-app';

const DAY = 86_400_000;

// ------------------------------------------------------------------ Nominatim falso

const nominatim = { mode: 'ok' as 'ok' | 'down', queries: [] as Record<string, string>[] };

function fakeNominatim(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const params = Object.fromEntries(new URL(req.url!, 'http://x').searchParams);
    nominatim.queries.push(params);
    if (nominatim.mode === 'down') return res.writeHead(503).end();
    const reply = (rows: unknown[]) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows));
    const street = params.street ?? '';
    if (/^N34-120 Av\. Amazonas$/.test(street)) {
      return reply([
        {
          lat: '-0.1765',
          lon: '-78.4800',
          display_name: 'N34-120, Avenida Amazonas, Iñaquito, Quito, Pichincha, Ecuador',
          category: 'place',
          type: 'house',
          addresstype: 'place',
          address: { house_number: 'N34-120', road: 'Avenida Amazonas', city: 'Quito', state: 'Pichincha' },
        },
      ]);
    }
    if (street === 'Av. Amazonas') {
      return reply([
        // Homónimo en otra ciudad: debe descartarse.
        { lat: '-2.9', lon: '-79.0', display_name: 'Avenida Amazonas, Cuenca, Azuay, Ecuador', category: 'highway', address: { city: 'Cuenca', state: 'Azuay' } },
        { lat: '-0.1790', lon: '-78.4820', display_name: 'Avenida Amazonas, Quito, Pichincha, Ecuador', category: 'highway', address: { city: 'Quito', state: 'Pichincha' } },
      ]);
    }
    if ((params.q ?? '').startsWith('La Floresta, Quito')) {
      return reply([{ lat: '-0.2100', lon: '-78.4850', display_name: 'La Floresta, Quito, Pichincha, Ecuador', category: 'place', addresstype: 'suburb', address: { city: 'Quito' } }]);
    }
    return reply([]);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * CRM de punta a punta (HTTP + PostgreSQL): direcciones geocodificadas con un Nominatim falso o con
 * pin, wishlist con alertas, puntos pendientes hasta pasar el plazo de devolución con reversa por
 * reembolso y niveles, canje por gift card, y referidos con cupón de recompensa.
 */
describe('CRM y fidelización (integración)', () => {
  let app: INestApplication;
  let db: Database;
  let relay: OutboxRelay;
  let orders: OrdersApi;
  let server: http.Server;
  let t: TestTenant;
  let staff: string;
  let warehouseId: string;
  let ana: string;
  let luis: string;

  beforeAll(async () => {
    server = await fakeNominatim();
    process.env.NOMINATIM_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.NOMINATIM_TIMEOUT_MS = '1000';
    ({ app, db, relay } = await createTestApp({ withCrm: true }));
    orders = app.get(OrdersApi);
    t = await createTenant(db);
    staff = `Bearer ${signAccessToken(
      { id: t.userId, tenantId: t.tenantId, type: 'staff', permissions: ['crm.read', 'crm.loyalty.adjust', 'crm.tiers.write'] },
      process.env.JWT_SECRET!,
    )}`;
    warehouseId = await createWarehouse(db, t.tenantId);
    ana = await createCustomer(db, t.tenantId);
    luis = await createCustomer(db, t.tenantId);
  });

  afterAll(async () => {
    await app.close();
    await new Promise((r) => server.close(r));
    delete process.env.NOMINATIM_URL;
  });

  const http_ = () => app.getHttpServer();
  const as = (userId: string) => `Bearer ${customerTokenFor(t.tenantId, userId)}`;

  /** Pedido con una línea de `price` (sin IVA, 15 %) y envío 3.00, entregado al cliente. */
  async function deliveredOrder(userId: string, item: { productId: string; variantId: string }, price = '40.00', deliveredAt?: Date): Promise<string> {
    const input: NewOrder = {
      id: randomUUID(),
      tenantId: t.tenantId,
      userId,
      customer: { name: 'Ana Pérez', email: 'ana@example.test' },
      billing: { idType: '05', idNumber: '1712345678' },
      paymentMethod: 'card',
      fulfillmentType: 'rider',
      shippingAddress: { mainStreet: 'Av. Amazonas', city: 'Quito' },
      shippingLocation: { lat: -0.18, lng: -78.47 },
      shippingCity: 'Quito',
      sourceWarehouseId: warehouseId,
      shippingTotal: '3.00',
      items: [{ ...item, sku: `SKU-${randomUUID().slice(0, 6)}`, productName: 'Vestido', quantity: 1, unitPrice: price, taxCode: '4', taxRate: '15.00', warehouseId }],
    };
    const o = await orders.placeOrder(input);
    await orders.markPaid(t.tenantId, o.id);
    for (const to of ['preparing', 'shipped', 'in_transit', 'delivered'] as const) await orders.changeStatus(t.tenantId, o.id, to);
    if (deliveredAt) await db.query(`UPDATE sales.orders SET delivered_at = $2 WHERE id = $1`, [o.id, deliveredAt]);
    return o.id;
  }

  /** Simula el ReturnRefunded que emite Pedidos al reembolsar (el flujo completo está en returns.int-spec). */
  async function returnRefunded(orderId: string, userId: string, total: string, returnId = randomUUID()): Promise<string> {
    const payload = {
      returnId,
      orderId,
      orderNumber: '1',
      rmaNumber: 'RMA-1',
      userId,
      customerEmail: 'ana@example.test',
      type: 'return',
      status: 'refunded',
      resolution: 'refund_original',
      refundAmount: total,
      actorId: null,
      items: [{ returnItemId: randomUUID(), orderItemId: randomUUID(), variantId: randomUUID(), sku: 'X', quantity: 1, reasonCode: 'size_small', condition: 'new', restock: true, exchangeVariantId: null, total }],
    };
    await db.query(
      `INSERT INTO platform.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1, 'sales.return', $2, 'ReturnRefunded', $3)`,
      [t.tenantId, returnId, JSON.stringify(payload)],
    );
    return returnId;
  }

  async function openReturn(orderId: string, status = 'requested'): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sales.returns (tenant_id, order_id, rma_number, type, status, reason) VALUES ($1, $2, $3, 'return', $4, 'Talla') RETURNING id`,
      [t.tenantId, orderId, `RMA-${randomUUID().slice(0, 8)}`, status],
    );
    return rows[0].id;
  }

  // ================================================================== direcciones

  describe('direcciones', () => {
    const base = { recipientName: 'Ana Pérez', recipientPhone: '0991234567', province: 'Pichincha', city: 'Quito' };

    it('geocodifica con número de casa (rooftop) y la primera queda predeterminada', async () => {
      const res = await request(http_())
        .post('/v1/me/addresses')
        .set('Authorization', as(ana))
        .send({ ...base, label: 'Casa', mainStreet: 'Av. Amazonas', houseNumber: 'N34-120', crossStreet: 'Naciones Unidas' })
        .expect(201);
      expect(res.body.geocode.status).toBe('found');
      expect(res.body.address).toMatchObject({
        location: { lat: -0.1765, lng: -78.48 },
        geocodeAccuracy: 'rooftop',
        isDefault: true,
        needsPin: false,
        pinRecommended: false,
      });
      expect(nominatim.queries.at(-1)).toMatchObject({ countrycodes: 'ec', street: 'N34-120 Av. Amazonas', city: 'Quito', state: 'Pichincha' });
    });

    it('sin número cae a la calle (descarta el homónimo de otra ciudad) y recomienda el pin', async () => {
      const res = await request(http_()).post('/v1/me/addresses').set('Authorization', as(ana)).send({ ...base, mainStreet: 'Av. Amazonas' }).expect(201);
      expect(res.body.address).toMatchObject({ location: { lat: -0.179, lng: -78.482 }, geocodeAccuracy: 'street', isDefault: false, pinRecommended: true });
    });

    it('si no encuentra la calle usa el barrio (approximate); si tampoco, queda sin ubicación (needsPin)', async () => {
      const barrio = await request(http_())
        .post('/v1/me/addresses')
        .set('Authorization', as(ana))
        .send({ ...base, mainStreet: 'Calle Inexistente', neighborhood: 'La Floresta' })
        .expect(201);
      expect(barrio.body.address).toMatchObject({ geocodeAccuracy: 'approximate', needsPin: false, pinRecommended: true });

      const nada = await request(http_()).post('/v1/me/addresses').set('Authorization', as(ana)).send({ ...base, mainStreet: 'Calle Inexistente' }).expect(201);
      expect(nada.body.geocode.status).toBe('not_found');
      expect(nada.body.address).toMatchObject({ location: null, geocodeAccuracy: null, needsPin: true });

      // El pin manual la completa.
      const pinned = await request(http_())
        .put(`/v1/me/addresses/${nada.body.address.id}/location`)
        .set('Authorization', as(ana))
        .send({ lat: -0.2, lng: -78.49 })
        .expect(200);
      expect(pinned.body).toMatchObject({ location: { lat: -0.2, lng: -78.49 }, geocodeAccuracy: 'user_pin', needsPin: false });
    });

    it('con Nominatim caído la dirección se guarda igual (unavailable, needsPin)', async () => {
      nominatim.mode = 'down';
      try {
        const res = await request(http_()).post('/v1/me/addresses').set('Authorization', as(luis)).send({ ...base, mainStreet: 'Av. Amazonas' }).expect(201);
        expect(res.body.geocode.status).toBe('unavailable');
        expect(res.body.address.needsPin).toBe(true);
      } finally {
        nominatim.mode = 'ok';
      }
    });

    it('con pin no consulta Nominatim y rechaza puntos fuera de Ecuador', async () => {
      const before = nominatim.queries.length;
      const ok = await request(http_())
        .post('/v1/me/addresses')
        .set('Authorization', as(luis))
        .send({ ...base, mainStreet: 'Calle 1', pin: { lat: -0.74, lng: -90.31 } })
        .expect(201);
      expect(ok.body.address.geocodeAccuracy).toBe('user_pin');
      expect(nominatim.queries.length).toBe(before);
      const bad = await request(http_()).post('/v1/me/addresses').set('Authorization', as(luis)).send({ ...base, mainStreet: 'Calle 1', pin: { lat: 4.7, lng: -74.07 } }).expect(422);
      expect(bad.body.error.code).toBe('LOCATION_OUT_OF_COUNTRY');
    });

    it('cambiar la calle vuelve a geocodificar; cambiar la referencia no', async () => {
      const created = (await request(http_()).post('/v1/me/addresses').set('Authorization', as(luis)).send({ ...base, mainStreet: 'Calle Inexistente' }).expect(201)).body.address;
      const ref = await request(http_()).patch(`/v1/me/addresses/${created.id}`).set('Authorization', as(luis)).send({ reference: 'Edificio azul' }).expect(200);
      expect(ref.body.geocode.status).toBe('kept');
      const moved = await request(http_())
        .patch(`/v1/me/addresses/${created.id}`)
        .set('Authorization', as(luis))
        .send({ mainStreet: 'Av. Amazonas', houseNumber: 'N34-120' })
        .expect(200);
      expect(moved.body.address).toMatchObject({ geocodeAccuracy: 'rooftop', reference: 'Edificio azul' });
    });

    it('vista previa para el mapa sin guardar nada', async () => {
      const res = await request(http_()).post('/v1/me/addresses/geocode').set('Authorization', as(ana)).send({ province: 'Pichincha', city: 'Quito', mainStreet: 'Av. Amazonas' }).expect(200);
      expect(res.body).toEqual({ status: 'found', candidates: [{ lat: -0.179, lng: -78.482, accuracy: 'street', displayName: 'Avenida Amazonas, Quito, Pichincha, Ecuador' }] });
    });

    it('predeterminada única; al borrarla pasa a la más reciente; otro cliente no la ve', async () => {
      const list = (await request(http_()).get('/v1/me/addresses').set('Authorization', as(ana)).expect(200)).body;
      expect(list.filter((a: { isDefault: boolean }) => a.isDefault)).toHaveLength(1);
      const other = list.find((a: { isDefault: boolean }) => !a.isDefault);
      await request(http_()).post(`/v1/me/addresses/${other.id}/default`).set('Authorization', as(ana)).expect(200);
      const after = (await request(http_()).get('/v1/me/addresses').set('Authorization', as(ana)).expect(200)).body;
      expect(after[0]).toMatchObject({ id: other.id, isDefault: true });
      expect(after.filter((a: { isDefault: boolean }) => a.isDefault)).toHaveLength(1);

      await request(http_()).get(`/v1/me/addresses/${other.id}`).set('Authorization', as(luis)).expect(404);
      await request(http_()).delete(`/v1/me/addresses/${other.id}`).set('Authorization', as(ana)).expect(204);
      const rest = (await request(http_()).get('/v1/me/addresses').set('Authorization', as(ana)).expect(200)).body;
      expect(rest.filter((a: { isDefault: boolean }) => a.isDefault)).toHaveLength(1);
    });

    it('checkout con addressId: la dirección guardada sin pin responde ADDRESS_NEEDS_PIN', async () => {
      const crm = app.get(CrmApi);
      const noPin = (await request(http_()).post('/v1/me/addresses').set('Authorization', as(luis)).send({ ...base, mainStreet: 'Calle Inexistente' }).expect(201)).body.address;
      const res = await request(http_()).post('/v1/checkout/delivery-options').set('Authorization', as(luis)).send({ addressId: noPin.id }).expect(422);
      expect(res.body.error.code).toBe('ADDRESS_NEEDS_PIN');
      await expect(crm.getCheckoutAddress(t.tenantId, ana, noPin.id)).rejects.toMatchObject({ code: 'ADDRESS_NOT_FOUND' });
      const pinned = (await request(http_()).post('/v1/me/addresses').set('Authorization', as(luis)).send({ ...base, mainStreet: 'Calle 2', crossStreet: 'Calle 3', pin: { lat: -0.18, lng: -78.47 } }).expect(201)).body.address;
      await expect(crm.getCheckoutAddress(t.tenantId, luis, pinned.id)).resolves.toMatchObject({ mainStreet: 'Calle 2', secondaryStreet: 'Calle 3', city: 'Quito', province: 'Pichincha', lat: -0.18, lng: -78.47 });
    });
  });

  // ================================================================== wishlist

  describe('wishlist', () => {
    it('avisa la reposición y la bajada de precio una sola vez (con enfriamiento)', async () => {
      const wishlist = app.get(WishlistService);
      const p = await createSellableVariant(db, t.tenantId, { price: '40.00', name: 'Chaqueta de jean' });
      await setStock(db, p.variantId, warehouseId, 0);
      const added = await request(http_()).post('/v1/me/wishlist').set('Authorization', as(ana)).send({ productId: p.productId }).expect(201);
      expect(added.body).toMatchObject({ productName: 'Chaqueta de jean', price: '40.00', priceWithTax: '46.00', inStock: false, notifyBackInStock: true });

      const t0 = new Date();
      expect(await wishlist.scan(t0, t.tenantId)).toMatchObject({ backInStock: 0, priceDrops: 0 });

      await setStock(db, p.variantId, warehouseId, 5);
      expect(await wishlist.scan(new Date(t0.getTime() + 1000), t.tenantId)).toMatchObject({ backInStock: 1 });
      expect(await wishlist.scan(new Date(t0.getTime() + 2000), t.tenantId)).toMatchObject({ backInStock: 0 }); // ya avisado

      // Rebaja de 40 a 30 dentro del enfriamiento (24 h): no avisa; después sí, desde el precio anterior.
      await db.query(`UPDATE catalog.products SET base_price = 30.00 WHERE id = $1`, [p.productId]);
      expect(await wishlist.scan(new Date(t0.getTime() + 3600_000), t.tenantId)).toMatchObject({ priceDrops: 0 });
      expect(await wishlist.scan(new Date(t0.getTime() + 25 * 3600_000), t.tenantId)).toMatchObject({ priceDrops: 1 });

      const events = await outboxEvents(db, t.tenantId, 'WishlistBackInStock');
      expect(events.map((e) => e.payload)).toEqual([expect.objectContaining({ userId: ana, productId: p.productId, price: '40.00', priceWithTax: '46.00' })]);
      const drops = await outboxEvents(db, t.tenantId, 'WishlistPriceDropped');
      expect(drops.map((e) => e.payload)).toEqual([expect.objectContaining({ previousPrice: '40.00', price: '30.00', priceWithTax: '34.50' })]);
    });

    it('respeta las preferencias, valida la variante y otro cliente no ve la lista', async () => {
      const p = await createSellableVariant(db, t.tenantId, { price: '20.00' });
      const other = await createSellableVariant(db, t.tenantId, { price: '20.00' });
      const bad = await request(http_()).post('/v1/me/wishlist').set('Authorization', as(luis)).send({ productId: p.productId, variantId: other.variantId }).expect(422);
      expect(bad.body.error.code).toBe('INVALID_WISHLIST_VARIANT');
      await request(http_()).post('/v1/me/wishlist').set('Authorization', as(luis)).send({ productId: p.productId, variantId: p.variantId }).expect(201);
      const prefs = await request(http_()).patch(`/v1/me/wishlist/${p.productId}`).set('Authorization', as(luis)).send({ notifyPriceDrop: false }).expect(200);
      expect(prefs.body).toMatchObject({ notifyPriceDrop: false, notifyBackInStock: true, variantId: p.variantId });
      const mine = (await request(http_()).get('/v1/me/wishlist').set('Authorization', as(luis)).expect(200)).body;
      expect(mine.map((i: { productId: string }) => i.productId)).toEqual([p.productId]);
      await request(http_()).delete(`/v1/me/wishlist/${p.productId}`).set('Authorization', as(ana)).expect(404);
      await request(http_()).delete(`/v1/me/wishlist/${p.productId}`).set('Authorization', as(luis)).expect(204);
      await request(http_()).post('/v1/me/wishlist').set('Authorization', as(luis)).send({ productId: randomUUID() }).expect(404);
    });
  });

  // ================================================================== puntos y niveles

  describe('puntos y niveles', () => {
    let product: { productId: string; variantId: string };
    let marta: string;

    beforeAll(async () => {
      product = await createSellableVariant(db, t.tenantId, { price: '40.00' });
      marta = await createCustomer(db, t.tenantId);
      for (const tier of [
        { name: 'Bronce', minPoints: 0, multiplier: '1.00' },
        { name: 'Plata', minPoints: 50, multiplier: '1.50' },
      ]) {
        await request(http_()).post('/v1/crm/loyalty/tiers').set('Authorization', staff).send(tier).expect(201);
      }
    });

    it('niveles: nombre y mínimo únicos', async () => {
      const dup = await request(http_()).post('/v1/crm/loyalty/tiers').set('Authorization', staff).send({ name: 'Plata', minPoints: 99, multiplier: '1.10' }).expect(409);
      expect(dup.body.error.code).toBe('TIER_CONFLICT');
      // Formato y tamaño los corta el DTO: multiplicador con 3 decimales, benefits de más de 2 KB.
      await request(http_()).post('/v1/crm/loyalty/tiers').set('Authorization', staff).send({ name: 'Oro', minPoints: 500, multiplier: '1.255' }).expect(400);
      await request(http_())
        .post('/v1/crm/loyalty/tiers')
        .set('Authorization', staff)
        .send({ name: 'Oro', minPoints: 500, multiplier: '2.00', benefits: { text: 'x'.repeat(2100) } })
        .expect(400);
      const tiers = (await request(http_()).get('/v1/crm/loyalty/tiers').set('Authorization', staff).expect(200)).body;
      expect(tiers.map((x: { name: string; multiplier: string }) => `${x.name} ${x.multiplier}`)).toEqual(['Bronce 1.00', 'Plata 1.50']);
    });

    it('la entrega deja puntos pendientes; un reembolso los revierte en proporción; el plazo los acredita y sube de nivel', async () => {
      const loyalty = app.get(LoyaltyService);
      const deliveredAt = new Date(Date.now() - 2 * DAY);
      const orderId = await deliveredOrder(marta, product, '40.00', deliveredAt);
      await relay.drain({ tenantId: t.tenantId });
      await relay.drain({ tenantId: t.tenantId }); // repetido: idempotente

      // Mercadería 46.00 (IVA incluido, sin envío) × 1 punto/USD × Bronce 1.00 = 46.
      let account = (await request(http_()).get('/v1/me/loyalty').set('Authorization', as(marta)).expect(200)).body;
      expect(account).toMatchObject({ pointsBalance: 0, pointsPending: 46, lifetimePoints: 0, tier: { name: 'Bronce' }, nextTier: { name: 'Plata', pointsToGo: 50 } });
      expect(account.pending).toEqual([{ orderId, points: 46, availableAt: new Date(deliveredAt.getTime() + 30 * DAY).toISOString() }]);

      // Devolución abierta al vencer el plazo: se pospone.
      const returnRow = await openReturn(orderId);
      const afterWindow = new Date(deliveredAt.getTime() + 31 * DAY);
      expect(await loyalty.matureDue(afterWindow, t.tenantId)).toMatchObject({ posted: 0, postponed: 1 });

      // Reembolso de 23.00 de 46.00 → reversa de 23 puntos (pendiente); el evento repetido no descuenta dos veces.
      const returnId = await returnRefunded(orderId, marta, '23.00');
      await relay.drain({ tenantId: t.tenantId });
      await db.query(`INSERT INTO platform.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
                      SELECT tenant_id, aggregate_type, aggregate_id, event_type, payload FROM platform.outbox_events
                       WHERE tenant_id = $1 AND event_type = 'ReturnRefunded' AND aggregate_id = $2`, [t.tenantId, returnId]);
      await relay.drain({ tenantId: t.tenantId });
      account = (await request(http_()).get('/v1/me/loyalty').set('Authorization', as(marta)).expect(200)).body;
      expect(account.pointsPending).toBe(23);

      await db.query(`UPDATE sales.returns SET status = 'refunded' WHERE id = $1`, [returnRow]);
      expect(await loyalty.matureDue(new Date(afterWindow.getTime() + 2 * DAY), t.tenantId)).toMatchObject({ posted: 1 });
      account = (await request(http_()).get('/v1/me/loyalty').set('Authorization', as(marta)).expect(200)).body;
      expect(account).toMatchObject({ pointsBalance: 23, pointsPending: 0, lifetimePoints: 23, pending: [] });

      // Segundo pedido (46 × 1.00) → 69 históricos → Plata.
      await deliveredOrder(marta, product, '40.00', deliveredAt);
      await relay.drain({ tenantId: t.tenantId });
      await loyalty.matureDue(new Date(afterWindow.getTime() + 3 * DAY), t.tenantId);
      account = (await request(http_()).get('/v1/me/loyalty').set('Authorization', as(marta)).expect(200)).body;
      expect(account).toMatchObject({ pointsBalance: 69, lifetimePoints: 69, tier: { name: 'Plata', multiplier: '1.50' }, nextTier: null });
      expect((await outboxEvents(db, t.tenantId, 'LoyaltyTierChanged')).map((e) => e.payload)).toEqual([
        expect.objectContaining({ userId: marta, fromTierName: 'Bronce', toTierName: 'Plata' }),
      ]);

      // Con Plata, el siguiente pedido gana 46 × 1.50 = 69 pendientes.
      await deliveredOrder(marta, product, '40.00');
      await relay.drain({ tenantId: t.tenantId });
      account = (await request(http_()).get('/v1/me/loyalty').set('Authorization', as(marta)).expect(200)).body;
      expect(account.pointsPending).toBe(69);

      const history = (await request(http_()).get('/v1/me/loyalty/transactions').set('Authorization', as(marta)).expect(200)).body;
      expect(history.map((h: { type: string; points: number; status: string }) => `${h.type}:${h.points}:${h.status}`).sort()).toEqual(
        ['earn:46:posted', 'earn:46:posted', 'earn:69:pending', 'reversal:-23:posted'].sort(),
      );
    });

    it('canje por gift card en bloques de 100 y con mínimo; ajustes del backoffice', async () => {
      await request(http_()).post(`/v1/crm/customers/${marta}/loyalty/adjustments`).set('Authorization', staff).send({ points: 531, reason: 'Compensación por demora' }).expect(201);
      let account = (await request(http_()).get(`/v1/crm/customers/${marta}/loyalty`).set('Authorization', staff).expect(200)).body;
      expect(account).toMatchObject({ pointsBalance: 600, redemption: { pointsPerUsd: 100, minPoints: 500, maxAmount: '6.00' } });

      expect((await request(http_()).post('/v1/me/loyalty/redemptions').set('Authorization', as(marta)).send({ points: 400 }).expect(422)).body.error.code).toBe(
        'REDEMPTION_BELOW_MINIMUM',
      );
      expect((await request(http_()).post('/v1/me/loyalty/redemptions').set('Authorization', as(marta)).send({ points: 550 }).expect(422)).body.error.code).toBe(
        'REDEMPTION_NOT_MULTIPLE',
      );
      expect((await request(http_()).post('/v1/me/loyalty/redemptions').set('Authorization', as(marta)).send({ points: 700 }).expect(409)).body.error.code).toBe(
        'INSUFFICIENT_POINTS',
      );
      const redeemed = await request(http_()).post('/v1/me/loyalty/redemptions').set('Authorization', as(marta)).send({ points: 500 }).expect(201);
      expect(redeemed.body).toMatchObject({ points: 500, amount: '5.00', pointsBalance: 100, giftCard: { balance: '5.00' } });
      expect(redeemed.body.giftCard.code).toEqual(expect.any(String));
      const card = await db.query<{ balance: string; status: string; purchaser_id: string }>(`SELECT balance, status, purchaser_id FROM sales.gift_cards WHERE id = $1`, [
        redeemed.body.giftCard.id,
      ]);
      expect(card.rows[0]).toEqual({ balance: '5.00', status: 'active', purchaser_id: marta });

      const neg = await request(http_()).post(`/v1/crm/customers/${marta}/loyalty/adjustments`).set('Authorization', staff).send({ points: -101, reason: 'Error' }).expect(409);
      expect(neg.body.error.code).toBe('INSUFFICIENT_POINTS');
      account = (await request(http_()).get(`/v1/crm/customers/${marta}/loyalty`).set('Authorization', staff).expect(200)).body;
      expect(account.pointsBalance).toBe(100);
      await request(http_()).get(`/v1/crm/customers/${t.userId}/loyalty`).set('Authorization', staff).expect(404); // staff, no cliente

      // La ficha del cliente (PII) y los ajustes quedan en la auditoría con el actor.
      const audit = await db.query<{ action: string; outcome: string }>(
        `SELECT action, after->>'outcome' AS outcome FROM platform.audit_log
          WHERE tenant_id = $1 AND entity_type = 'customer' AND entity_id = $2 ORDER BY id`,
        [t.tenantId, marta],
      );
      expect(audit.rows).toEqual(
        expect.arrayContaining([
          { action: 'crm.points.adjust', outcome: 'ok' },
          { action: 'crm.points.adjust', outcome: 'failed' },
          { action: 'crm.customer.view', outcome: 'ok' },
        ]),
      );
    });

    it('un nivel con clientes no se borra', async () => {
      const tiers = (await request(http_()).get('/v1/crm/loyalty/tiers').set('Authorization', staff).expect(200)).body;
      const plata = tiers.find((x: { name: string }) => x.name === 'Plata');
      expect((await request(http_()).delete(`/v1/crm/loyalty/tiers/${plata.id}`).set('Authorization', staff).expect(409)).body.error.code).toBe('TIER_IN_USE');
    });
  });

  // ================================================================== referidos

  describe('referidos', () => {
    it('código, aplicación, calificación con el primer pedido y cupón al pasar el plazo', async () => {
      const referrals = app.get(ReferralService);
      const referrer = await createCustomer(db, t.tenantId);
      const referee = await createCustomer(db, t.tenantId);
      const buyer = await createCustomer(db, t.tenantId);
      const product = await createSellableVariant(db, t.tenantId, { price: '40.00' });

      const summary = (await request(http_()).get('/v1/me/referral').set('Authorization', as(referrer)).expect(200)).body;
      expect(summary).toMatchObject({ rewardAmount: '10.00', minOrderAmount: '30.00', referrals: [] });
      expect(summary.code).toMatch(/^[A-Z2-9]{8}$/);
      expect((await request(http_()).get('/v1/me/referral').set('Authorization', as(referrer)).expect(200)).body.code).toBe(summary.code);

      const code = `${summary.code.slice(0, 4).toLowerCase()}-${summary.code.slice(4)}`;
      expect((await request(http_()).post('/v1/me/referral/apply').set('Authorization', as(referrer)).send({ code }).expect(409)).body.error.details.reason).toBe('SELF_REFERRAL');
      expect((await request(http_()).post('/v1/me/referral/apply').set('Authorization', as(referee)).send({ code: 'ZZZZ2222' }).expect(404)).body.error.code).toBe(
        'REFERRAL_CODE_NOT_FOUND',
      );
      await request(http_()).post('/v1/me/referral/apply').set('Authorization', as(referee)).send({ code }).expect(200);
      const again = await request(http_()).post('/v1/me/referral/apply').set('Authorization', as(referee)).send({ code }).expect(409);
      expect(again.body.error.details.reason).toBe('ALREADY_REFERRED');

      // Quien ya compró no puede usar un código.
      await deliveredOrder(buyer, product);
      expect((await request(http_()).post('/v1/me/referral/apply').set('Authorization', as(buyer)).send({ code }).expect(409)).body.error.details.reason).toBe('HAS_ORDERS');

      // Primer pedido del referido (46.00 >= 30.00) → calificado.
      const deliveredAt = new Date(Date.now() - DAY);
      const orderId = await deliveredOrder(referee, product, '40.00', deliveredAt);
      await relay.drain({ tenantId: t.tenantId });
      expect((await request(http_()).get('/v1/me/referral').set('Authorization', as(referrer)).expect(200)).body.counts).toMatchObject({ qualified: 1 });

      // Antes del plazo espera; después, cupón personal para el referente.
      expect(await referrals.matureQualified(new Date(), t.tenantId)).toMatchObject({ rewarded: 0, waiting: 1 });
      expect(await referrals.matureQualified(new Date(deliveredAt.getTime() + 31 * DAY), t.tenantId)).toMatchObject({ rewarded: 1 });
      expect(await referrals.matureQualified(new Date(deliveredAt.getTime() + 32 * DAY), t.tenantId)).toMatchObject({ rewarded: 0 }); // idempotente

      const [rewarded] = await outboxEvents(db, t.tenantId, 'ReferralRewarded');
      expect(rewarded.payload).toMatchObject({ referrerId: referrer, refereeId: referee, orderId, rewardAmount: '10.00' });
      const { rows } = await db.query<{ code: string; assigned_user_id: string; max_uses: number; name: string; benefit: { amount: string } }>(
        `SELECT c.code, c.assigned_user_id, c.max_uses, p.name, p.benefit FROM sales.coupons c JOIN sales.promotions p ON p.id = c.promotion_id WHERE c.tenant_id = $1`,
        [t.tenantId],
      );
      expect(rows).toEqual([{ code: rewarded.payload.couponCode, assigned_user_id: referrer, max_uses: 1, name: 'Recompensa por referido', benefit: { amount: '10.00' } }]);
      expect((await request(http_()).get('/v1/me/referral').set('Authorization', as(referrer)).expect(200)).body.counts).toMatchObject({ rewarded: 1, qualified: 0 });
    });
  });
});
