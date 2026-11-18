import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { NewOrder, OrdersApi } from '../../libs/modules/orders';
import { SettlementService } from '../../libs/modules/logistics/application/settlement.service';
import { Database } from '../../libs/shared-kernel';
import {
  createCustomer,
  createRider,
  createRiderShipment,
  createTenant,
  createVariants,
  createWarehouse,
  customerTokenFor,
  outboxEvents,
  riderTokenFor,
  SETTLEMENT_PERMISSIONS,
  TestTenant,
  tokenFor,
} from '../support/fixtures';
import { createTestApp } from '../support/test-app';

/** Instante UTC de una hora local de Guayaquil (UTC−5). */
const local = (isoLocal: string) => new Date(`${isoLocal}-05:00`);
const DAY = 24 * 60 * 60 * 1000;

describe('Logística: calificaciones y liquidaciones de motorizados', () => {
  let app: INestApplication;
  let db: Database;
  let orders: OrdersApi;
  let t: TestTenant;
  let staff: string;
  let warehouseId: string;
  let variantId: string;

  const api = () => request(app.getHttpServer());
  const asCustomer = (id: string) => `Bearer ${customerTokenFor(t.tenantId, id)}`;
  const asRider = (userId: string) => `Bearer ${riderTokenFor(t.tenantId, userId)}`;

  async function placeOrder(userId: string | null): Promise<string> {
    const input: NewOrder = {
      id: randomUUID(),
      tenantId: t.tenantId,
      userId,
      customer: { name: 'Ana Pérez', email: 'ana@example.test' },
      billing: { idType: '05', idNumber: '1712345678' },
      paymentMethod: 'cod',
      fulfillmentType: 'rider',
      shippingAddress: { mainStreet: 'Av. Amazonas', city: 'Quito' },
      shippingLocation: { lat: -0.1765, lng: -78.48 },
      shippingCity: 'Quito',
      sourceWarehouseId: warehouseId,
      shippingTotal: '3.00',
      items: [
        {
          variantId,
          productId: randomUUID(),
          sku: 'BLU-LIN-M',
          productName: 'Blusa lino',
          quantity: 1,
          unitPrice: '20.00',
          taxCode: '4',
          taxRate: '15.00',
          warehouseId,
        },
      ],
    };
    return (await orders.placeOrder(input)).id;
  }

  const riderRow = async (riderId: string) =>
    (
      await db.query<{ rating_avg: string; rating_count: number; cod_balance: string }>(
        `SELECT rating_avg, rating_count, cod_balance FROM logistics.riders WHERE id = $1`,
        [riderId],
      )
    ).rows[0];

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    orders = app.get(OrdersApi);
    t = await createTenant(db);
    staff = `Bearer ${tokenFor(t, SETTLEMENT_PERMISSIONS)}`;
    warehouseId = await createWarehouse(db, t.tenantId);
    [variantId] = await createVariants(db, t.tenantId, 1);
  });

  afterAll(async () => {
    await app?.close();
  });

  // =====================================================================
  describe('calificaciones mutuas', () => {
    let rider: { riderId: string; userId: string };
    let customer: string;

    beforeAll(async () => {
      rider = await createRider(db, t.tenantId);
      customer = await createCustomer(db, t.tenantId);
    });

    const delivered = async (opts: { userId?: string | null; riderId?: string; deliveredAt?: Date | null; status?: string } = {}) =>
      createRiderShipment(db, {
        tenantId: t.tenantId,
        orderId: await placeOrder(opts.userId === undefined ? customer : opts.userId),
        riderId: opts.riderId ?? rider.riderId,
        deliveredAt: opts.deliveredAt,
        status: opts.status,
      });

    const rate = (shipmentId: string, body: object, token = asCustomer(customer)) =>
      api().post(`/v1/me/shipments/${shipmentId}/rating`).set('Authorization', token).send(body);

    it('el cliente califica al motorizado: actualiza rating_avg y emite RiderRated', async () => {
      const first = await delivered();
      const res = await rate(first, { score: 4, tags: ['Puntual'], comment: 'Llegó a tiempo' }).expect(201);
      expect(res.body.rating).toMatchObject({ shipmentId: first, raterType: 'customer', score: 4, tags: ['puntual'], comment: 'Llegó a tiempo' });
      expect(res.body.rider).toEqual({ id: rider.riderId, ratingAvg: '4.00', ratingCount: 1 });

      await rate(await delivered(), { score: 5 }).expect(201);
      expect(await riderRow(rider.riderId)).toMatchObject({ rating_avg: '4.50', rating_count: 2 });

      const events = await outboxEvents(db, t.tenantId, 'RiderRated');
      expect(events.at(-1)?.payload).toMatchObject({ riderId: rider.riderId, customerId: customer, score: 5, ratingAvg: '4.50', ratingCount: 2 });
    });

    it('una sola calificación por entrega (409 ALREADY_RATED)', async () => {
      const s = await delivered();
      await rate(s, { score: 3 }).expect(201);
      const again = await rate(s, { score: 1 }).expect(409);
      expect(again.body.error.code).toBe('ALREADY_RATED');
    });

    it('10 calificaciones en paralelo: el promedio no pierde ninguna', async () => {
      const r = await createRider(db, t.tenantId);
      const shipments = await Promise.all(Array.from({ length: 10 }, () => delivered({ riderId: r.riderId })));
      const scores = [5, 4, 3, 5, 2, 5, 4, 1, 5, 3]; // promedio 3.70
      const results = await Promise.all(shipments.map((s, i) => rate(s, { score: scores[i] })));
      expect(results.map((x) => x.status)).toEqual(Array(10).fill(201));
      expect(await riderRow(r.riderId)).toMatchObject({ rating_avg: '3.70', rating_count: 10 });
    });

    it('envío ajeno o de courier → 404; sin entregar o fuera de plazo → 409', async () => {
      const other = await createCustomer(db, t.tenantId);
      expect((await rate(await delivered(), { score: 5 }, asCustomer(other)).expect(404)).body.error.code).toBe('SHIPMENT_NOT_FOUND');

      const courier = await createRiderShipment(db, { tenantId: t.tenantId, orderId: await placeOrder(customer), riderId: null, carrierType: 'courier' });
      await rate(courier, { score: 5 }).expect(404);

      const inTransit = await delivered({ status: 'in_transit', deliveredAt: null });
      expect((await rate(inTransit, { score: 5 }).expect(409)).body.error).toMatchObject({
        code: 'SHIPMENT_NOT_RATEABLE',
        details: { reason: 'NOT_DELIVERED' },
      });
      const old = await delivered({ deliveredAt: new Date(Date.now() - 8 * DAY) });
      expect((await rate(old, { score: 5 }).expect(409)).body.error.details.reason).toBe('WINDOW_CLOSED');
    });

    it('valida puntaje y etiquetas; solo clientes', async () => {
      const s = await delivered();
      await rate(s, { score: 6 }).expect(400);
      expect((await rate(s, { score: 2, tags: ['no_contesta'] }).expect(422)).body.error.code).toBe('INVALID_RATING_TAG');
      await rate(s, { score: 5 }, asRider(rider.userId)).expect(403);
    });

    it('el motorizado califica al cliente: CustomerRated con el promedio del cliente', async () => {
      const s1 = await delivered();
      const s2 = await delivered();
      const rateCustomer = (s: string, body: object, token = asRider(rider.userId)) =>
        api().post(`/v1/rider/shipments/${s}/rating`).set('Authorization', token).send(body);

      await rateCustomer(s1, { score: 5, tags: ['ubicacion_precisa'] }).expect(201);
      const res = await rateCustomer(s2, { score: 2, tags: ['no_contesta'], comment: 'No contestó el teléfono' }).expect(201);
      expect(res.body.customer).toEqual({ id: customer, ratingAvg: '3.50', ratingCount: 2 });
      const events = await outboxEvents(db, t.tenantId, 'CustomerRated');
      expect(events.at(-1)?.payload).toMatchObject({ customerId: customer, riderId: rider.riderId, score: 2, customerRatingAvg: '3.50' });

      // El cliente y el motorizado califican la misma entrega: son dos lados distintos.
      await rate(s1, { score: 5 }).expect(201);
      // Otro motorizado no puede calificar una entrega ajena.
      const other = await createRider(db, t.tenantId);
      await rateCustomer(await delivered(), { score: 4 }, asRider(other.userId)).expect(404);
      // Pedido de invitado: no hay cliente al que calificar.
      const guest = await delivered({ userId: null });
      expect((await rateCustomer(guest, { score: 4 }).expect(422)).body.error.code).toBe('CUSTOMER_NOT_RATEABLE');
      // Un cliente no entra a las rutas del motorizado.
      await rateCustomer(s2, { score: 4 }, asCustomer(customer)).expect(403);
    });

    it('backoffice: promedio y últimas calificaciones del motorizado', async () => {
      const res = await api().get(`/v1/logistics/riders/${rider.riderId}/ratings?limit=2`).set('Authorization', staff).expect(200);
      expect(res.body).toMatchObject({ riderId: rider.riderId, ratingCount: expect.any(Number) });
      expect(res.body.ratings).toHaveLength(2);
      expect(res.body.ratings[0]).not.toHaveProperty('raterId');
    });
  });

  // =====================================================================
  describe('liquidaciones semanales', () => {
    const SCHEME = { per_delivery: 2.5, per_km: 0.3, bonus_tiers: [{ min_deliveries: 4, amount: 5 }] };
    const WEEK = { start: '2026-09-21', end: '2026-09-27' };
    let rider: { riderId: string; userId: string };
    let customer: string;
    let settlements: SettlementService;

    const generate = (body: object = { periodStart: WEEK.start }, token = staff) =>
      api().post('/v1/logistics/settlements/generate').set('Authorization', token).send(body);
    const settlementOf = async (riderId: string, start = WEEK.start) =>
      (await api().get(`/v1/logistics/settlements?riderId=${riderId}&periodStart=${start}`).set('Authorization', staff).expect(200)).body[0];
    const ship = async (riderId: string, opts: Omit<Parameters<typeof createRiderShipment>[1], 'tenantId' | 'orderId' | 'riderId'>) =>
      createRiderShipment(db, { tenantId: t.tenantId, orderId: await placeOrder(customer), riderId, ...opts });

    beforeAll(async () => {
      settlements = app.get(SettlementService);
      customer = await createCustomer(db, t.tenantId);
      // Efectivo en mano: $45 (A) + $25 (C). Límite $50 → sobre el límite.
      rider = await createRider(db, t.tenantId, { commissionScheme: SCHEME, codLimit: '50.00', codBalance: '70.00' });
      await ship(rider.riderId, { deliveredAt: local('2026-09-22T10:00:00'), distanceM: 3_000, codMethod: 'cash', codCollected: '45.00' }); // A
      await ship(rider.riderId, { deliveredAt: local('2026-09-24T16:00:00'), distanceM: 5_000, codMethod: 'deuna_qr', codCollected: '40.00' }); // B
      await ship(rider.riderId, { deliveredAt: local('2026-09-27T23:30:00'), distanceM: 1_000, codMethod: 'cash', codCollected: '25.00' }); // C: domingo tarde
      await ship(rider.riderId, { deliveredAt: local('2026-09-10T12:00:00'), distanceM: null }); // E: semana anterior sin liquidar
      // Fuera: lunes siguiente, intento fallido y envío por courier.
      await ship(rider.riderId, { deliveredAt: local('2026-09-28T00:30:00') });
      await ship(rider.riderId, { status: 'failed_attempt', deliveredAt: null });
      await ship(rider.riderId, { carrierType: 'courier', deliveredAt: local('2026-09-23T12:00:00') });
    });

    it('agrupa las entregas del motorizado, calcula comisiones y propone retener el efectivo', async () => {
      const res = await generate().expect(200);
      // Otros motorizados del tenant (bloque de calificaciones) también entran: se revisa este.
      expect(res.body).toMatchObject({ period: WEEK, failed: [] });
      expect(res.body.created).toBeGreaterThanOrEqual(1);
      expect(res.body.codLimitExceeded).toContain(rider.riderId);

      const s = await settlementOf(rider.riderId);
      // Comisiones: A 2.50+0.90, B 2.50+1.50, C 2.50+0.30, E 2.50 (sin distancia) = 12.70; bono (4 entregas) 5.00.
      expect(s).toMatchObject({
        status: 'draft',
        periodStart: WEEK.start,
        periodEnd: WEEK.end,
        deliveriesCount: 4,
        grossFees: '12.70',
        bonuses: '5.00',
        codCollected: '70.00', // DeUna no pasa por las manos del motorizado
        codRemitted: '0.00',
        deductions: '17.70', // debe $70: se propone retener todo lo que gana
        netPayable: '0.00',
      });

      const detail = await api().get(`/v1/logistics/settlements/${s.id}`).set('Authorization', staff).expect(200);
      expect(detail.body.items).toHaveLength(4);
      expect(detail.body.items.map((i: { fee: string }) => i.fee).sort()).toEqual(['2.50', '2.80', '3.40', '4.00']);
      expect(detail.body.cod).toEqual({ codBalance: '70.00', codLimit: '50.00', codAvailable: '0.00', overLimit: true });

      expect((await outboxEvents(db, t.tenantId, 'RiderSettlementDrafted')).some((e) => e.aggregate_id === s.id)).toBe(true);
      const alerts = await outboxEvents(db, t.tenantId, 'RiderCodLimitExceeded');
      expect(alerts.at(-1)?.payload).toMatchObject({ riderId: rider.riderId, codBalance: '70.00', codLimit: '50.00' });
    });

    it('es idempotente y recoge entregas tardías del período', async () => {
      const before = await settlementOf(rider.riderId);
      await ship(rider.riderId, { deliveredAt: local('2026-09-26T09:00:00'), distanceM: 2_000 });
      const res = await generate().expect(200);
      expect(res.body.created).toBe(0);
      expect(res.body.updated).toBeGreaterThanOrEqual(1);
      const after = await settlementOf(rider.riderId);
      expect(after).toMatchObject({ id: before.id, deliveriesCount: 5, grossFees: '15.80' });
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM logistics.rider_settlement_items WHERE settlement_id = $1`, [after.id]);
      expect(rows[0].n).toBe(5);
    });

    it('dos generaciones concurrentes dejan una sola liquidación', async () => {
      const r = await createRider(db, t.tenantId);
      await ship(r.riderId, { deliveredAt: local('2026-09-23T11:00:00') });
      const results = await Promise.all([generate(), generate(), generate()]);
      expect(results.map((x) => x.status)).toEqual([200, 200, 200]);
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM logistics.rider_settlements WHERE rider_id = $1`, [r.riderId]);
      expect(rows[0].n).toBe(1);
    });

    it('job: sin periodStart liquida la semana anterior a "ahora"', async () => {
      const r = await createRider(db, t.tenantId);
      await ship(r.riderId, { deliveredAt: local('2026-09-15T11:00:00') });
      const res = await settlements.generate({ tenantId: t.tenantId, now: local('2026-09-21T03:00:00') });
      expect(res.period).toEqual({ start: '2026-09-14', end: '2026-09-20' });
      expect((await settlementOf(r.riderId, '2026-09-14')).deliveriesCount).toBe(1);
    });

    it('un commission_scheme inválido no frena al resto', async () => {
      const bad = await createRider(db, t.tenantId, { commissionScheme: { per_delivery: 'gratis' } });
      await ship(bad.riderId, { deliveredAt: local('2026-09-23T11:00:00') });
      const res = await generate().expect(200);
      expect(res.body.failed).toEqual([expect.objectContaining({ riderId: bad.riderId, code: 'INVALID_COMMISSION_SCHEME' })]);
      expect(res.body.updated).toBeGreaterThanOrEqual(1);
    });

    it('valida el período: lunes y semana cerrada', async () => {
      expect((await generate({ periodStart: '2026-09-22' }).expect(422)).body.error.code).toBe('INVALID_SETTLEMENT_PERIOD');
      expect((await generate({ periodStart: '2099-01-05' }).expect(422)).body.error.code).toBe('SETTLEMENT_PERIOD_NOT_CLOSED');
    });

    it('aprobación en backoffice: efectivo rendido, retención y cod_balance', async () => {
      const s = await settlementOf(rider.riderId);
      const approve = (body: object, token = staff) => api().post(`/v1/logistics/settlements/${s.id}/approve`).set('Authorization', token).send(body);

      await approve({ codRemitted: '60.00' }, `Bearer ${tokenFor(t, ['logistics.read', 'logistics.settlement.manage'])}`).expect(403);
      expect((await approve({ codRemitted: '70.01' }).expect(422)).body.error.code).toBe('COD_REMITTED_EXCEEDS_BALANCE');

      // Rinde $60 de $70: se retienen $10 de sus $20.80 (15.80 + 5.00 de bono).
      const [ok, dup] = await Promise.all([approve({ codRemitted: '60.00' }), approve({ codRemitted: '60.00' })]);
      expect([ok.status, dup.status].sort()).toEqual([200, 409]);
      const approved = ok.status === 200 ? ok : dup;
      expect(approved.body).toMatchObject({ status: 'approved', approvedBy: t.userId, codRemitted: '60.00', deductions: '10.00', netPayable: '10.80' });
      expect(approved.body.cod).toMatchObject({ codBalance: '0.00', overLimit: false });
      expect((await riderRow(rider.riderId)).cod_balance).toBe('0.00');

      const events = await outboxEvents(db, t.tenantId, 'RiderSettlementApproved');
      expect(events.at(-1)?.payload).toMatchObject({ settlementId: s.id, codBalanceBefore: '70.00', codBalanceAfter: '0.00', netPayable: '10.80' });

      // Aprobada: el job ya no la recalcula aunque aparezca otra entrega del período.
      await ship(rider.riderId, { deliveredAt: local('2026-09-25T09:00:00') });
      const res = await generate().expect(200);
      expect(res.body.skipped).toBeGreaterThanOrEqual(1);
      expect((await settlementOf(rider.riderId)).deliveriesCount).toBe(5);

      // Segregación: quien aprobó no puede marcarla pagada (mismo permiso, otra persona).
      const same = await api().post(`/v1/logistics/settlements/${s.id}/mark-paid`).set('Authorization', staff).expect(409);
      expect(same.body.error.code).toBe('SETTLEMENT_SAME_APPROVER');
      const treasurerId = (
        await db.query<{ id: string }>(`INSERT INTO iam.users (tenant_id, user_type, email) VALUES ($1, 'staff', $2) RETURNING id`, [
          t.tenantId,
          `tesoreria+${s.id.slice(0, 8)}@example.test`,
        ])
      ).rows[0].id;
      const treasurer = `Bearer ${tokenFor({ ...t, userId: treasurerId }, SETTLEMENT_PERMISSIONS)}`;

      const paid = await api().post(`/v1/logistics/settlements/${s.id}/mark-paid`).set('Authorization', treasurer).expect(200);
      expect(paid.body.status).toBe('paid');
      expect(paid.body.paidAt).toEqual(expect.any(String));
      const audit = await db.query(
        `SELECT actor_id, after->>'outcome' AS outcome FROM platform.audit_log WHERE action = 'logistics.settlement.mark_paid' AND entity_id = $1 ORDER BY id`,
        [s.id],
      );
      expect(audit.rows).toEqual([
        { actor_id: t.userId, outcome: 'failed' },
        { actor_id: treasurerId, outcome: 'ok' },
      ]);
      const again = await api().post(`/v1/logistics/settlements/${s.id}/mark-paid`).set('Authorization', treasurer).expect(409);
      expect(again.body.error.code).toBe('INVALID_SETTLEMENT_TRANSITION');
    });

    it('el efectivo que la comisión no cubre queda como saldo', async () => {
      const r = await createRider(db, t.tenantId, { codBalance: '30.00' });
      await ship(r.riderId, { deliveredAt: local('2026-09-23T11:00:00'), distanceM: 0, codMethod: 'cash', codCollected: '30.00' });
      await generate().expect(200);
      const s = await settlementOf(r.riderId);
      const res = await api().post(`/v1/logistics/settlements/${s.id}/approve`).set('Authorization', staff).send({ codRemitted: '0.00' }).expect(200);
      // Gana $2.50 y no rinde nada: se retiene todo y quedan $27.50 de saldo.
      expect(res.body).toMatchObject({ deductions: '2.50', netPayable: '0.00', cod: { codBalance: '27.50' } });
    });

    it('app del motorizado: ve y disputa lo suyo; el backoffice recalcula la disputa', async () => {
      const r = await createRider(db, t.tenantId);
      await ship(r.riderId, { deliveredAt: local('2026-09-23T11:00:00') });
      await generate().expect(200);
      const s = await settlementOf(r.riderId);

      const mine = await api().get('/v1/rider/settlements').set('Authorization', asRider(r.userId)).expect(200);
      expect(mine.body.map((x: { id: string }) => x.id)).toEqual([s.id]);
      await api().get(`/v1/rider/settlements/${s.id}`).set('Authorization', asRider(rider.userId)).expect(404);

      await api().post(`/v1/rider/settlements/${s.id}/dispute`).set('Authorization', asRider(r.userId)).send({ reason: 'Falta una entrega del jueves' }).expect(200);
      const events = await outboxEvents(db, t.tenantId, 'RiderSettlementDisputed');
      expect(events.at(-1)?.payload).toMatchObject({ settlementId: s.id, reason: 'Falta una entrega del jueves', disputedBy: { type: 'rider', id: r.userId } });

      // El job no pisa la disputa; el backoffice la recalcula a pedido (vuelve a borrador).
      await ship(r.riderId, { deliveredAt: local('2026-09-24T11:00:00') });
      await generate().expect(200);
      expect(await settlementOf(r.riderId)).toMatchObject({ status: 'disputed', deliveriesCount: 1 });
      await generate({ periodStart: WEEK.start, rebuildDisputed: true }).expect(200);
      expect(await settlementOf(r.riderId)).toMatchObject({ status: 'draft', deliveriesCount: 2 });
    });
  });
});
