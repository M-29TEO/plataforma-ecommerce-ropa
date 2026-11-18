import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { LogisticsApi, ResolvedDelivery } from '../../libs/modules/logistics';
import { DeliveryQuoteService } from '../../libs/modules/logistics/application/delivery-quote.service';
import { Database } from '../../libs/shared-kernel';
import { QUITO_ZONES, seedLogistics, SeededLogistics } from '../../scripts/seed-logistics';
import { createTenant, createWarehouse, TestTenant, tokenFor } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

/**
 * Servicios externos falsos en el mismo proceso: OSRM (/route/v1/driving) y la API del courier
 * simulado (/v1/quotes). El test cambia su comportamiento con `osrmMode` y `courierMode`.
 */
type Mode = 'ok' | 'fail' | 'slow';
let osrmMode: Mode = 'fail';
let courierMode: Mode = 'fail';
const OSRM_DISTANCE_M = 7_000;

function fakeServer(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, body, res));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const url = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
const json = (res: http.ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

const LOGISTICS = ['logistics.read', 'logistics.zone.write'];
const NORTE = QUITO_ZONES.find((z) => z.key === 'norte')!;
const CENTRO = QUITO_ZONES.find((z) => z.key === 'centro')!;
const CUMBAYA = QUITO_ZONES.find((z) => z.key === 'cumbaya')!;
/** Bodega del seed (Av. Amazonas, cerca del Parque Bicentenario), dentro de la zona Norte. */
const WAREHOUSE = { lat: -0.15, lng: -78.485 };

describe('Logística (cotización)', () => {
  let app: INestApplication;
  let db: Database;
  let osrm: http.Server;
  let courier: http.Server;
  let t: TestTenant;
  let auth: string;
  let warehouseId: string;
  let seeded: SeededLogistics;

  const api = () => request(app.getHttpServer());
  /** El DTO rechaza propiedades desconocidas: se quita el `label` de los puntos de ejemplo. */
  const quote = ({ label: _label, ...destination }: Record<string, unknown>, weightG = 800, extra: Record<string, unknown> = {}) =>
    api().post('/v1/logistics/quotes').set('Authorization', auth).send({ destination, weightG, merchandiseTotal: '30.00', ...extra });

  beforeAll(async () => {
    osrm = await fakeServer((_req, _body, res) => {
      if (osrmMode === 'fail') return json(res, 500, { code: 'InternalError' });
      json(res, 200, { code: 'Ok', routes: [{ distance: OSRM_DISTANCE_M, duration: 900 }] });
    });
    courier = await fakeServer((req, body, res) => {
      if (req.headers['x-api-key'] !== process.env.COURIERSIM_API_KEY) return json(res, 401, {});
      if (courierMode === 'fail') return json(res, 503, { error: { code: 'SERVICE_UNAVAILABLE' } });
      const reply = () =>
        json(res, 200, {
          quoteId: 'q_test',
          validUntil: new Date(Date.now() + 1_800_000).toISOString(),
          echo: JSON.parse(body),
          options: [
            { serviceCode: 'ESTANDAR', serviceName: 'Estándar', price: '4.68', etaHours: 48 },
            { serviceCode: 'EXPRESS', serviceName: 'Express 24 h', price: '6.76', etaHours: 24 },
          ],
        });
      if (courierMode === 'slow') setTimeout(reply, 3_500).unref();
      else reply();
    });
    process.env.OSRM_URL = url(osrm);
    process.env.COURIERSIM_URL = url(courier);

    ({ app, db } = await createTestApp());
    t = await createTenant(db);
    auth = `Bearer ${tokenFor(t, LOGISTICS)}`;
    warehouseId = await createWarehouse(db, t.tenantId, { code: 'UIO-01', ...WAREHOUSE });
    seeded = await seedLogistics(db, t.tenantId, warehouseId);
    for (const zoneId of [seeded.zones.norte, seeded.zones.centro]) {
      await api().post(`/v1/logistics/zones/${zoneId}/slots/generate`).set('Authorization', auth).expect(200);
    }
  });

  afterAll(async () => {
    await app?.close();
    osrm?.closeAllConnections();
    courier?.closeAllConnections();
    await Promise.all([osrm, courier].map((s) => new Promise((r) => s?.close(r))));
  });

  beforeEach(() => {
    osrmMode = 'fail';
    courierMode = 'fail';
  });

  describe('zonas de cobertura (CRUD con GeoJSON)', () => {
    const square = (lng: number, lat: number, d = 0.01) => ({
      type: 'Polygon',
      coordinates: [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]],
    });
    const zoneBody = (overrides: Record<string, unknown> = {}) => ({
      name: `Zona ${randomUUID().slice(0, 6)}`,
      city: 'Quito',
      area: square(-78.6, -0.3),
      deliveryMode: 'rider',
      baseFee: '2.00',
      feePerKm: '0.25',
      servingWarehouseId: warehouseId,
      ...overrides,
    });

    it('crea, lee (área como MultiPolygon), edita y desactiva', async () => {
      const created = await api().post('/v1/logistics/zones').set('Authorization', auth).send(zoneBody({ sameDayCutoff: '13:30' })).expect(201);
      expect(created.body).toMatchObject({ deliveryMode: 'rider', baseFee: '2.00', feePerKm: '0.25', sameDayCutoff: '13:30', priority: 100, active: true });
      expect(created.body.area.type).toBe('MultiPolygon');
      expect(created.body.area.coordinates[0][0]).toHaveLength(5);

      const patched = await api()
        .patch(`/v1/logistics/zones/${created.body.id}`)
        .set('Authorization', auth)
        .send({ baseFee: '2.75', freeShippingThreshold: '50.00', sameDayCutoff: null })
        .expect(200);
      expect(patched.body).toMatchObject({ baseFee: '2.75', freeShippingThreshold: '50.00', sameDayCutoff: null, feePerKm: '0.25' });

      await api().delete(`/v1/logistics/zones/${created.body.id}`).set('Authorization', auth).expect(200);
      const list = await api().get('/v1/logistics/zones?active=false').set('Authorization', auth).expect(200);
      expect(list.body.map((z: { id: string }) => z.id)).toContain(created.body.id);
    });

    it.each([
      ['anillo abierto', { area: { type: 'Polygon', coordinates: [[[-78.6, -0.3], [-78.59, -0.3], [-78.59, -0.29], [-78.6, -0.29]]] } }, 'INVALID_AREA'],
      // "Moño": se cruza consigo mismo. La estructura es válida; lo detecta ST_IsValid de PostGIS.
      ['auto-intersección', { area: { type: 'Polygon', coordinates: [[[-78.6, -0.3], [-78.59, -0.29], [-78.59, -0.3], [-78.6, -0.29], [-78.6, -0.3]]] } }, 'INVALID_AREA'],
      ['motorizado sin bodega', { servingWarehouseId: null }, 'SERVING_WAREHOUSE_REQUIRED'],
      ['bodega de otro tenant', { servingWarehouseId: randomUUID() }, 'SERVING_WAREHOUSE_UNAVAILABLE'],
    ])('rechaza %s (422)', async (_name, overrides, code) => {
      const res = await api().post('/v1/logistics/zones').set('Authorization', auth).send(zoneBody(overrides)).expect(422);
      expect(res.body.error.code).toBe(code);
    });

    it('sin permiso logistics.zone.write → 403', async () => {
      await api().post('/v1/logistics/zones').set('Authorization', `Bearer ${tokenFor(t, ['logistics.read'])}`).send(zoneBody()).expect(403);
    });
  });

  describe('ZoneResolver (ST_Covers)', () => {
    const resolve = async (p: { lat: number; lng: number }) =>
      (await api().get(`/v1/logistics/zones/resolve?lat=${p.lat}&lng=${p.lng}`).set('Authorization', auth).expect(200)).body.zone;

    it('ubica los puntos de ejemplo del seed en su zona real de Quito', async () => {
      expect((await resolve(NORTE.samplePoint)).id).toBe(seeded.zones.norte);
      expect((await resolve(CENTRO.samplePoint)).id).toBe(seeded.zones.centro);
      expect((await resolve(CUMBAYA.samplePoint)).id).toBe(seeded.zones.cumbaya);
      expect(await resolve({ lat: -2.1894, lng: -79.8891 })).toBeNull(); // Guayaquil
    });

    it('con zonas superpuestas gana la de menor prioridad; el borde cuenta como cubierto', async () => {
      // Zona grande (todo el norte y centro de Quito) con prioridad 50: no le gana a Norte (10).
      const big = await api()
        .post('/v1/logistics/zones')
        .set('Authorization', auth)
        .send({
          name: 'Quito urbano (respaldo)',
          city: 'Quito',
          deliveryMode: 'both',
          priority: 50,
          baseFee: '4.00',
          servingWarehouseId: warehouseId,
          area: { type: 'Polygon', coordinates: [[[-78.56, -0.26], [-78.44, -0.26], [-78.44, -0.1], [-78.56, -0.1], [-78.56, -0.26]]] },
        })
        .expect(201);
      expect((await resolve(NORTE.samplePoint)).id).toBe(seeded.zones.norte);
      expect((await resolve({ lat: -0.25, lng: -78.53 })).id).toBe(big.body.id); // sur, fuera de Norte y Centro
      expect((await resolve({ lat: -0.26, lng: -78.5 })).id).toBe(big.body.id); // sobre el borde sur
      await api().delete(`/v1/logistics/zones/${big.body.id}`).set('Authorization', auth).expect(200);
      expect(await resolve({ lat: -0.25, lng: -78.53 })).toBeNull();
    });
  });

  describe('franjas (plantillas y capacidad)', () => {
    it('genera franjas desde las plantillas; volver a generar no duplica', async () => {
      const slots = await api().get(`/v1/logistics/zones/${seeded.zones.norte}/slots`).set('Authorization', auth).expect(200);
      expect(slots.body.length).toBeGreaterThan(10);
      expect(slots.body[0]).toMatchObject({ zoneId: seeded.zones.norte, booked: 0 });
      const again = await api().post(`/v1/logistics/zones/${seeded.zones.norte}/slots/generate`).set('Authorization', auth).expect(200);
      expect(again.body).toEqual({ created: 0 });
    });

    it('una plantilla nueva genera sus franjas; una inválida → 422', async () => {
      const zone = await api()
        .post('/v1/logistics/zones')
        .set('Authorization', auth)
        .send({
          name: `Franjas ${randomUUID().slice(0, 6)}`,
          city: 'Quito',
          deliveryMode: 'rider',
          baseFee: '2.00',
          servingWarehouseId: warehouseId,
          area: { type: 'Polygon', coordinates: [[[-78.7, -0.4], [-78.69, -0.4], [-78.69, -0.39], [-78.7, -0.39], [-78.7, -0.4]]] },
        })
        .expect(201);
      for (let weekday = 0; weekday < 7; weekday++) {
        await api()
          .post(`/v1/logistics/zones/${zone.body.id}/slot-templates`)
          .set('Authorization', auth)
          .send({ weekday, startTime: '23:00', endTime: '23:59', capacity: 3, surcharge: '0.50' })
          .expect(201);
      }
      const slots = await api().get(`/v1/logistics/zones/${zone.body.id}/slots`).set('Authorization', auth).expect(200);
      expect(slots.body.length).toBeGreaterThanOrEqual(6); // 7 días; la de hoy puede haber cerrado
      expect(slots.body[0]).toMatchObject({ capacity: 3, surcharge: '0.50' });

      const bad = await api()
        .post(`/v1/logistics/zones/${zone.body.id}/slot-templates`)
        .set('Authorization', auth)
        .send({ weekday: 1, startTime: '12:00', endTime: '09:00', capacity: 3 })
        .expect(422);
      expect(bad.body.error.code).toBe('INVALID_SLOT_TEMPLATE');
    });

    it('CHECK de la migración: la BD rechaza una plantilla que termina antes de empezar', async () => {
      await expect(
        db.query(
          `INSERT INTO logistics.delivery_slot_templates (zone_id, weekday, start_time, end_time, capacity) VALUES ($1, 1, '12:00', '09:00', 1)`,
          [seeded.zones.norte],
        ),
      ).rejects.toThrow(/ck_slot_tpl_time_order/);
    });
  });

  describe('cotización (DeliveryRulesEngine + RiderPricing + CourierQuoteAggregator)', () => {
    it('Norte con OSRM: motorizado, distancia real por calle y franjas con su precio', async () => {
      osrmMode = 'ok';
      const res = await quote({ ...NORTE.samplePoint, city: 'Quito' }).expect(200);
      expect(res.body).toMatchObject({ fulfillmentType: 'rider', reason: null, zone: { id: seeded.zones.norte } });
      const [option] = res.body.options;
      // 2.50 + 7.0 km × 0.35 = 4.95
      expect(option).toMatchObject({ type: 'rider', price: '4.95', distanceKm: 7, distanceSource: 'osrm', source: 'own_fleet' });
      expect(option.slots.length).toBeGreaterThan(0);
      const evening = option.slots.find((s: { surcharge: string }) => s.surcharge === '1.00');
      if (evening) expect(evening.price).toBe('5.95');
    });

    it('OSRM caído: línea recta × 1,3 (la cotización no falla)', async () => {
      const res = await quote({ ...NORTE.samplePoint, city: 'Quito' }).expect(200);
      const [option] = res.body.options;
      expect(option.distanceSource).toBe('straight_line');
      // Bodega (-0.15, -78.485) → CCI (-0.1765, -78.48): ~3,0 km en recta → ~3,9 km estimados
      expect(option.distanceKm).toBeGreaterThan(3.5);
      expect(option.distanceKm).toBeLessThan(4.3);
    });

    it('envío gratis en Norte desde $60 de mercadería', async () => {
      const res = await quote({ ...NORTE.samplePoint, city: 'Quito' }, 800, { merchandiseTotal: '60.00' }).expect(200);
      expect(res.body.options[0]).toMatchObject({ price: '0.00', breakdown: { freeShipping: true } });
    });

    it('Cumbayá (zona solo courier) con la API del courier respondiendo: source api', async () => {
      courierMode = 'ok';
      const res = await quote({ ...CUMBAYA.samplePoint, city: 'Cumbayá' }).expect(200);
      expect(res.body).toMatchObject({ fulfillmentType: 'courier', reason: 'COURIER_ONLY_ZONE', zone: { id: seeded.zones.cumbaya } });
      expect(res.body.options.map((o: { service: { code: string }; price: string; source: string }) => [o.service.code, o.price, o.source])).toEqual([
        ['ESTANDAR', '4.68', 'api'],
        ['EXPRESS', '6.76', 'api'],
      ]);
      const saved = await db.query(`SELECT source, price, selected FROM logistics.courier_quotes WHERE raw_response->>'quoteId' = 'q_test'`);
      expect(saved.rows.length).toBeGreaterThanOrEqual(2);
    });

    it('courier con error: respaldo inmediato con courier_rate_cards', async () => {
      const res = await quote({ lat: -2.1894, lng: -79.8891, city: 'Guayaquil' }).expect(200);
      expect(res.body).toMatchObject({ fulfillmentType: 'courier', reason: 'NO_ZONE', zone: null });
      expect(res.body.options.map((o: { service: { code: string }; price: string; source: string }) => [o.service.code, o.price, o.source])).toEqual([
        ['ESTANDAR', '6.00', 'rate_card'],
        ['EXPRESS', '8.50', 'rate_card'],
      ]);
    });

    it('courier lento: a los 3 s se corta y se usa el tarifario', async () => {
      courierMode = 'slow';
      const started = Date.now();
      const res = await quote({ lat: -2.9, lng: -79.0, city: 'Cuenca' }).expect(200);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(2_900);
      expect(elapsed).toBeLessThan(3_450);
      expect(res.body.options[0]).toMatchObject({ price: '6.00', source: 'rate_card' });
    });

    it('Centro sin cupo en ninguna franja → courier (NO_SLOT_CAPACITY)', async () => {
      await db.query(`UPDATE logistics.delivery_slots SET capacity = booked WHERE zone_id = $1`, [seeded.zones.centro]);
      try {
        const res = await quote({ ...CENTRO.samplePoint, city: 'Quito' }).expect(200);
        expect(res.body).toMatchObject({ fulfillmentType: 'courier', reason: 'NO_SLOT_CAPACITY' });
        expect(res.body.options[0]).toMatchObject({ price: '3.50', source: 'rate_card' }); // Quito ciudad
      } finally {
        await db.query(`UPDATE logistics.delivery_slots SET capacity = 2 WHERE zone_id = $1`, [seeded.zones.centro]);
      }
    });

    it('paquete de 12 kg en Centro (máximo 10 kg) → courier (OVERWEIGHT)', async () => {
      const res = await quote({ ...CENTRO.samplePoint, city: 'Quito' }, 12_000).expect(200);
      expect(res.body.reason).toBe('OVERWEIGHT');
    });

    it('sin provincia conocida no se puede cotizar courier → 422 NO_DELIVERY_COVERAGE', async () => {
      const res = await quote({ lat: -1.5, lng: -78.0, city: 'Recinto sin nombre' }).expect(422);
      expect(res.body.error.code).toBe('NO_DELIVERY_COVERAGE');
    });
  });

  describe('reserva de cupo y liberación (LogisticsApi)', () => {
    async function riderResolved(): Promise<{ resolved: ResolvedDelivery; slotId: string }> {
      const logistics = app.get(LogisticsApi);
      const destination = { ...CENTRO.samplePoint, city: 'Quito' };
      const q = await logistics.quoteDelivery({ tenantId: t.tenantId, destination, weightG: 500, volumeCm3: 0, merchandiseTotal: '20.00' });
      const option = q.options[0];
      const slotId = option.slots![0].slotId;
      const resolved = await logistics.resolveDelivery({
        tenantId: t.tenantId,
        quoteId: option.quoteId,
        slotId,
        destination,
        weightG: 500,
        volumeCm3: 0,
        merchandiseTotal: '20.00',
      });
      return { resolved, slotId };
    }

    const book = (resolved: ResolvedDelivery, orderId = randomUUID()) =>
      app.get(LogisticsApi).bookDelivery({
        tenantId: t.tenantId,
        orderId,
        resolved,
        originWarehouseId: null,
        destination: { address: { mainStreet: 'García Moreno' }, location: CENTRO.samplePoint, city: 'Quito' },
        weightG: 500,
        volumeCm3: 0,
        codAmount: '0.00',
      });

    it('dos reservas simultáneas por el último cupo: una entra y la otra recibe SLOT_UNAVAILABLE', async () => {
      const { resolved, slotId } = await riderResolved();
      await db.query(`UPDATE logistics.delivery_slots SET capacity = booked + 1 WHERE id = $1`, [slotId]);
      const results = await Promise.allSettled([book(resolved), book(resolved)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason.code).toBe('SLOT_UNAVAILABLE');
      const { rows } = await db.query(`SELECT booked, capacity FROM logistics.delivery_slots WHERE id = $1`, [slotId]);
      expect(rows[0].booked).toBe(rows[0].capacity);
    });

    it('cancelar el pedido libera el cupo una sola vez (evento repetido)', async () => {
      const { resolved, slotId } = await riderResolved();
      const before = (await db.query(`SELECT booked FROM logistics.delivery_slots WHERE id = $1`, [slotId])).rows[0].booked;
      const orderId = randomUUID();
      await book(resolved, orderId);
      const service = app.get(LogisticsApi);
      expect((await service.getShipments(t.tenantId, orderId))[0]).toMatchObject({ status: 'pending', carrierType: 'rider', deliverySlotId: slotId });

      const deliveries = app.get(DeliveryQuoteService);
      expect(await deliveries.cancelForOrder(t.tenantId, orderId, 'prueba')).toEqual({ cancelled: 1, releasedSlots: 1 });
      expect(await deliveries.cancelForOrder(t.tenantId, orderId, 'prueba')).toEqual({ cancelled: 0, releasedSlots: 0 });
      expect((await db.query(`SELECT booked FROM logistics.delivery_slots WHERE id = $1`, [slotId])).rows[0].booked).toBe(before);
      expect((await service.getShipments(t.tenantId, orderId))[0].status).toBe('cancelled');
    });

    it('una cotización alterada o de otro destino no se acepta', async () => {
      const { resolved: _r, slotId } = await riderResolved();
      const logistics = app.get(LogisticsApi);
      const q = await logistics.quoteDelivery({
        tenantId: t.tenantId,
        destination: { ...CENTRO.samplePoint, city: 'Quito' },
        weightG: 500,
        volumeCm3: 0,
        merchandiseTotal: '20.00',
      });
      const base = { tenantId: t.tenantId, quoteId: q.options[0].quoteId, slotId, destination: CENTRO.samplePoint, weightG: 500, volumeCm3: 0, merchandiseTotal: '20.00' };
      await expect(logistics.resolveDelivery({ ...base, destination: NORTE.samplePoint })).rejects.toMatchObject({ code: 'DELIVERY_QUOTE_MISMATCH' });
      await expect(logistics.resolveDelivery({ ...base, weightG: 900 })).rejects.toMatchObject({ code: 'DELIVERY_QUOTE_MISMATCH' });
      await expect(logistics.resolveDelivery({ ...base, tenantId: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_DELIVERY_QUOTE' });
      await expect(logistics.resolveDelivery({ ...base, quoteId: `${base.quoteId}x` })).rejects.toMatchObject({ code: 'INVALID_DELIVERY_QUOTE' });
      await expect(logistics.resolveDelivery({ ...base, slotId: null })).rejects.toMatchObject({ code: 'DELIVERY_SLOT_REQUIRED' });
    });
  });
});
