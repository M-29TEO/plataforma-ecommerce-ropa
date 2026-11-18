import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { ExportService } from '../../libs/modules/reports/application/export.service';
import { ReportStorage, ViewRefresher } from '../../libs/modules/reports/application/ports';
import { Database } from '../../libs/shared-kernel';
import { createRider, createTenant, createVariants, TestTenant, tokenFor } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

const ALL = ['reports.sales.read', 'reports.delivery.read', 'reports.funnel.read', 'reports.export'];
const RANGE = { from: '2026-09-01', to: '2026-09-30' };

/** Binario de supertest (xlsx/pdf) como Buffer. */
function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

/**
 * Reportes de punta a punta: datos sembrados directo en sales/logistics (escenario con fechas fijas
 * de septiembre de 2026) → REFRESH CONCURRENTLY → endpoints → exportes Excel/PDF por el worker.
 *
 *  O1 tarjeta, Quito / La Floresta, motorizado, 10-sep: 2 × A (neto 20, IVA 3, costo 8), envío 3 → total 26.
 *  O2 contra entrega, Quito, courier, 11-sep 03:00 UTC (= 10-sep 22:00 en Ecuador): 1 × B (neto 10, sin costo) → 11.50.
 *  O3 tarjeta, Guayaquil, motorizado, 12-sep: 3 × A con 1 devuelta (neto 20 conservado, 10 devuelto, costo 8) → 34.50.
 *  O4 tarjeta sin pagar y O5 cancelado (12-sep): no son ventas.
 */
describe('Reportes', () => {
  let app: INestApplication;
  let db: Database;
  let t: TestTenant;
  let bearer: string;
  let riderName: string;
  let courierId: string;

  const http = () => request(app.getHttpServer());
  const refresh = () => app.get(ViewRefresher).refreshAll();

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    t = await createTenant(db);
    bearer = `Bearer ${tokenFor(t, ALL)}`;
    await seed();
    await refresh();
  });

  afterAll(async () => {
    await app.close();
  });

  async function seed(): Promise<void> {
    const [a, b] = await createVariants(db, t.tenantId, 2);
    const { rows: pv } = await db.query<{ product_id: string }>(`SELECT product_id FROM catalog.product_variants WHERE id = $1`, [a]);
    const productId = pv[0].product_id;

    const rider = await createRider(db, t.tenantId);
    riderName = `Moto ${randomUUID().slice(0, 4)}`;
    await db.query(`UPDATE iam.users SET first_name = $2, last_name = 'Pérez' WHERE id = $1`, [rider.userId, riderName]);
    riderName = `${riderName} Pérez`;
    const courier = await db.query<{ id: string }>(
      `INSERT INTO logistics.couriers (tenant_id, code, name, adapter, secret_ref) VALUES ($1, 'sim', 'Courier Simulado', 'simulator', 'x') RETURNING id`,
      [t.tenantId],
    );
    courierId = courier.rows[0].id;
    const service = await db.query<{ id: string }>(
      `INSERT INTO logistics.courier_services (courier_id, code, name, sla_hours) VALUES ($1, 'std', 'Estándar', 24) RETURNING id`,
      [courierId],
    );

    async function order(o: {
      method: string; status: string; paymentStatus: string; city: string; address?: object; fulfillment: string;
      placedAt: string; paidAt?: string | null; total: string; shipping?: string; tax: string;
      items: { variant: string; qty: number; net: string; tax: string; cost: string | null; returned?: number; category: string; size: string; color: string }[];
    }): Promise<string> {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO sales.orders (tenant_id, customer, billing, status, payment_status, payment_method, fulfillment_type,
           shipping_address, shipping_city, subtotal, shipping_total, tax_total, total, placed_at, paid_at)
         VALUES ($1, '{}'::jsonb, '{}'::jsonb, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [t.tenantId, o.status, o.paymentStatus, o.method, o.fulfillment, JSON.stringify(o.address ?? { city: o.city }), o.city,
          o.total, o.shipping ?? '0', o.tax, o.total, o.placedAt, o.paidAt ?? null],
      );
      for (const i of o.items) {
        const lineTotal = (Number(i.net) + Number(i.tax)).toFixed(2);
        await db.query(
          `INSERT INTO sales.order_items (order_id, variant_id, product_id, sku, product_name, category_path, color_name, size_code,
             quantity, unit_price, tax_code, tax_rate, tax_amount, line_total, unit_cost, qty_returned)
           VALUES ($1, $2, $3, $4, 'Blusa', $5, $6, $7, $8, $9, '4', 15, $10, $11, $12, $13)`,
          [rows[0].id, i.variant, productId, `SKU-${randomUUID().slice(0, 6)}`, i.category, i.color, i.size, i.qty,
            (Number(i.net) / i.qty).toFixed(2), i.tax, lineTotal, i.cost, i.returned ?? 0],
        );
      }
      return rows[0].id;
    }

    async function shipment(s: {
      orderId: string; carrier: 'rider' | 'courier'; riderId?: string; serviceId?: string; status: string; createdAt: string;
      pickedUpAt?: string; deliveredAt?: string; eta?: string; attempts?: number;
    }): Promise<string> {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO logistics.shipments (tenant_id, order_id, carrier_type, rider_id, courier_service_id, tracking_token, status,
           destination, weight_g, attempts, eta, picked_up_at, delivered_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, 800, $8, $9, $10, $11, $12) RETURNING id`,
        [t.tenantId, s.orderId, s.carrier, s.riderId ?? null, s.serviceId ?? null, `trk-${randomUUID()}`, s.status, s.attempts ?? 0,
          s.eta ?? null, s.pickedUpAt ?? null, s.deliveredAt ?? null, s.createdAt],
      );
      return rows[0].id;
    }

    const A = { variant: a, category: 'mujer/blusas', size: 'M', color: 'Rojo' };
    const B = { variant: b, category: 'hombre/camisas', size: 'L', color: 'Azul' };
    const o1 = await order({
      method: 'card', status: 'delivered', paymentStatus: 'paid', city: 'Quito', fulfillment: 'rider',
      address: { city: 'Quito', neighborhood: 'La Floresta' },
      placedAt: '2026-09-10T15:00:00Z', paidAt: '2026-09-10T15:05:00Z', total: '26.00', shipping: '3.00', tax: '3.00',
      items: [{ ...A, qty: 2, net: '20.00', tax: '3.00', cost: '4.00' }],
    });
    const o2 = await order({
      method: 'cod', status: 'delivered', paymentStatus: 'paid', city: 'Quito', fulfillment: 'courier',
      placedAt: '2026-09-11T03:00:00Z', paidAt: '2026-09-13T04:00:00Z', total: '11.50', tax: '1.50',
      items: [{ ...B, qty: 1, net: '10.00', tax: '1.50', cost: null }],
    });
    const o3 = await order({
      method: 'card', status: 'partially_returned', paymentStatus: 'partially_refunded', city: 'Guayaquil', fulfillment: 'rider',
      placedAt: '2026-09-12T15:00:00Z', paidAt: '2026-09-12T15:01:00Z', total: '34.50', tax: '4.50',
      items: [{ ...A, qty: 3, net: '30.00', tax: '4.50', cost: '4.00', returned: 1 }],
    });
    await order({
      method: 'card', status: 'created', paymentStatus: 'pending', city: 'Quito', fulfillment: 'rider',
      placedAt: '2026-09-12T16:00:00Z', total: '11.50', tax: '1.50', items: [{ ...B, qty: 1, net: '10.00', tax: '1.50', cost: null }],
    });
    await order({
      method: 'card', status: 'cancelled', paymentStatus: 'refunded', city: 'Quito', fulfillment: 'rider',
      placedAt: '2026-09-12T17:00:00Z', paidAt: '2026-09-12T17:01:00Z', total: '11.50', tax: '1.50',
      items: [{ ...B, qty: 1, net: '10.00', tax: '1.50', cost: null }],
    });

    // S1: 90 min desde el pago, 65 en ruta, antes del ETA, calificado con 5.
    const s1 = await shipment({
      orderId: o1, carrier: 'rider', riderId: rider.riderId, status: 'delivered', createdAt: '2026-09-10T15:10:00Z',
      pickedUpAt: '2026-09-10T15:30:00Z', deliveredAt: '2026-09-10T16:35:00Z', eta: '2026-09-10T17:00:00Z',
    });
    await db.query(
      `INSERT INTO logistics.ratings (shipment_id, rater_type, rater_id, ratee_id, score) VALUES ($1, 'customer', $2, $3, 5)`,
      [s1, randomUUID(), rider.userId],
    );
    // S2: contra entrega, 49 h desde la compra (no desde paid_at) con SLA de 24 h → tarde.
    await shipment({
      orderId: o2, carrier: 'courier', serviceId: service.rows[0].id, status: 'delivered', createdAt: '2026-09-11T04:00:00Z',
      deliveredAt: '2026-09-13T04:00:00Z',
    });
    // S3: intento fallido.
    await shipment({ orderId: o3, carrier: 'rider', riderId: rider.riderId, status: 'failed_attempt', createdAt: '2026-09-12T15:30:00Z', attempts: 1 });

    // Carritos del 10-sep: 3 convertidos, 1 abandonado (20.00, con recordatorio), 1 vacío y 1 fusionado (no cuenta).
    async function cart(status: string, items: [string, number, string][], reminders = 0): Promise<void> {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO sales.carts (tenant_id, status, reminders_sent, last_activity_at, created_at)
         VALUES ($1, $2, $3, '2026-09-10T16:00:00Z', '2026-09-10T15:00:00Z') RETURNING id`,
        [t.tenantId, status, reminders],
      );
      for (const [variant, qty, price] of items) {
        await db.query(`INSERT INTO sales.cart_items (cart_id, variant_id, quantity, price_at_add) VALUES ($1, $2, $3, $4)`, [rows[0].id, variant, qty, price]);
      }
    }
    for (let i = 0; i < 3; i++) await cart('converted', [[a, 1, '11.50']]);
    await cart('active', [[a, 1, '10.00'], [b, 2, '5.00']], 2);
    await cart('active', []);
    await cart('merged', [[a, 1, '10.00']]);
  }

  const get = (path: string, query: Record<string, unknown> = {}, auth = bearer) =>
    http().get(`/v1/reports/${path}`).query({ ...RANGE, ...query }).set('Authorization', auth);

  describe('ventas', () => {
    it('totales: solo pedidos pagados o contra entrega; neto sin IVA y sin devoluciones; margen con costo conocido', async () => {
      const res = await get('sales', { groupBy: 'payment_method' });
      expect(res.status).toBe(200);
      expect(res.body.totals).toEqual({
        orders: 3, units: 6, grossSales: '72.00', netSales: '50.00', returns: '10.00', cost: '16.00',
        margin: '24.00', marginPct: 60, averageTicket: '24.00',
      });
      expect(res.body.dataAsOf).toEqual(expect.any(String));
      expect(res.body.rows.map((r: { label: string; orders: number }) => [r.label, r.orders])).toEqual([
        ['Tarjeta', 2],
        ['Contra entrega', 1],
      ]);
    });

    it('por día en hora de Ecuador, con los días sin ventas en cero', async () => {
      const res = await get('sales', { groupBy: 'day', from: '2026-09-10', to: '2026-09-12' });
      expect(res.body.rows.map((r: { key: string; orders: number; grossSales: string }) => [r.key, r.orders, r.grossSales])).toEqual([
        ['2026-09-10', 2, '37.50'],
        ['2026-09-11', 0, '0.00'],
        ['2026-09-12', 1, '34.50'],
      ]);
    });

    it('por semana y por mes', async () => {
      const week = await get('sales', { groupBy: 'week' });
      expect(week.body.rows.find((r: { key: string }) => r.key === '2026-09-07').orders).toBe(3);
      const month = await get('sales', { groupBy: 'month' });
      expect(month.body.rows).toEqual([expect.objectContaining({ key: '2026-09', orders: 3, netSales: '50.00' })]);
    });

    it('por ciudad, barrio, courier y motorizado', async () => {
      const city = await get('sales', { groupBy: 'city' });
      expect(city.body.rows.map((r: { label: string; orders: number }) => [r.label, r.orders])).toEqual([
        ['Quito', 2],
        ['Guayaquil', 1],
      ]);
      const hood = await get('sales', { groupBy: 'neighborhood' });
      expect(hood.body.rows.map((r: { label: string }) => r.label).sort()).toEqual([
        'La Floresta (Quito)', 'Sin barrio (Guayaquil)', 'Sin barrio (Quito)',
      ]);
      const courier = await get('sales', { groupBy: 'courier' });
      expect(courier.body.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: courierId, label: 'Courier Simulado', orders: 1 }),
          expect.objectContaining({ key: '', label: 'Flota propia o retiro' }),
        ]),
      );
      const rider = await get('sales', { groupBy: 'rider' });
      expect(rider.body.rows).toEqual(expect.arrayContaining([expect.objectContaining({ label: riderName, orders: 2 })]));
    });

    it('por categoría, talla, color y producto', async () => {
      const cat = await get('sales/items', { groupBy: 'category' });
      expect(cat.body.rows.map((r: { label: string; units: number; netSales: string; marginPct: number | null }) => [r.label, r.units, r.netSales, r.marginPct])).toEqual([
        ['mujer/blusas', 5, '40.00', 60],
        ['hombre/camisas', 1, '10.00', null],
      ]);
      const size = await get('sales/items', { groupBy: 'size', limit: 1 });
      expect(size.body.rows).toEqual([expect.objectContaining({ label: 'M', unitsReturned: 1, returns: '10.00' })]);
      const color = await get('sales/items', { groupBy: 'color' });
      expect(color.body.rows.map((r: { label: string }) => r.label)).toEqual(['Rojo', 'Azul']);
      const product = await get('sales/items', { groupBy: 'product' });
      expect(product.body.rows[0]).toMatchObject({ label: 'Blusa', units: 6 });
    });
  });

  describe('entregas', () => {
    it('tiempos, cumplimiento (contra entrega cuenta desde la compra) y calificación', async () => {
      const res = await get('delivery', { groupBy: 'carrier_type' });
      expect(res.status).toBe(200);
      expect(res.body.totals).toEqual({
        shipments: 3, delivered: 2, failed: 1, cancelled: 0, deliveryRate: 66.67,
        avgLeadMinutes: 1515, avgTransitMinutes: 65, onTimeRate: 50,
        within2h: 1, within24h: 0, within48h: 0, over48h: 1, ratingAvg: 5,
      });
      expect(res.body.rows.map((r: { label: string; shipments: number }) => [r.label, r.shipments])).toEqual([
        ['Motorizado', 2],
        ['Courier', 1],
      ]);
    });

    it('por motorizado y por courier', async () => {
      const rider = await get('delivery', { groupBy: 'rider' });
      expect(rider.body.rows[0]).toMatchObject({ label: riderName, shipments: 2, delivered: 1, failed: 1, onTimeRate: 100 });
      const courier = await get('delivery', { groupBy: 'courier' });
      expect(courier.body.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Courier Simulado', onTimeRate: 0, avgLeadMinutes: 2940 }),
          expect.objectContaining({ key: '', label: 'Flota propia', shipments: 2 }),
        ]),
      );
    });
  });

  describe('embudo', () => {
    it('conversión y carritos abandonados (los fusionados no cuentan)', async () => {
      const res = await get('funnel', { groupBy: 'day', from: '2026-09-10', to: '2026-09-10' });
      expect(res.body.rows).toEqual([
        expect.objectContaining({
          key: '2026-09-10', cartsCreated: 5, cartsWithItems: 4, cartsAbandoned: 1, abandonmentRate: 25,
          abandonedValue: '20.00', cartsReminded: 1, ordersPlaced: 2, ordersPaid: 2, conversionRate: 50, revenue: '37.50',
        }),
      ]);
      const month = await get('funnel', { groupBy: 'month' });
      expect(month.body.totals).toMatchObject({ ordersPlaced: 5, ordersPaid: 3, conversionRate: 75 });
    });
  });

  it('KPIs del tablero con el período anterior', async () => {
    const res = await http().get('/v1/reports/kpis').query(RANGE).set('Authorization', bearer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ from: '2026-09-01', to: '2026-09-30', previousFrom: '2026-08-02', previousTo: '2026-08-31' });
    expect(res.body.sales.current).toMatchObject({ orders: 3, averageTicket: '24.00', marginPct: 60 });
    expect(res.body.sales.previous).toMatchObject({ orders: 0, averageTicket: null });
    expect(res.body.funnel.current).toMatchObject({ conversionRate: 75, cartsAbandoned: 1 });
    expect(res.body.delivery.current).toMatchObject({ avgLeadMinutes: 1515, onTimeRate: 50 });
  });

  it('las vistas solo cambian al refrescar, y dos refrescos simultáneos no chocan', async () => {
    await db.query(`UPDATE sales.order_items SET qty_returned = 2 WHERE order_id IN (SELECT id FROM sales.orders WHERE tenant_id = $1 AND total = 34.50)`, [t.tenantId]);
    expect((await get('sales')).body.totals.returns).toBe('10.00');
    const [r1, r2] = await Promise.all([refresh(), refresh()]);
    for (let i = 0; i < r1.length; i++) expect(r1[i].ms !== null || r2[i].ms !== null).toBe(true);
    expect((await get('sales')).body.totals.returns).toBe('20.00');
    await db.query(`UPDATE sales.order_items SET qty_returned = 1 WHERE order_id IN (SELECT id FROM sales.orders WHERE tenant_id = $1 AND total = 34.50)`, [t.tenantId]);
    await refresh();
  });

  describe('permisos y validación', () => {
    it('401 sin token, 403 sin el permiso del reporte', async () => {
      expect((await http().get('/v1/reports/sales')).status).toBe(401);
      const onlyFunnel = `Bearer ${tokenFor(t, ['reports.funnel.read'])}`;
      expect((await get('sales', {}, onlyFunnel)).status).toBe(403);
      expect((await get('delivery', {}, onlyFunnel)).status).toBe(403);
      expect((await get('funnel', {}, onlyFunnel)).status).toBe(200);
      expect((await http().get('/v1/reports/kpis').set('Authorization', onlyFunnel)).status).toBe(403);
    });

    it('groupBy fuera de la lista blanca → 422 con los permitidos; fecha mal formada → 400', async () => {
      const bad = await get('funnel', { groupBy: 'city' });
      expect(bad.status).toBe(422);
      expect(bad.body).toMatchObject({ error: { code: 'INVALID_GROUP_BY', details: { allowed: ['day', 'week', 'month'] } } });
      expect((await get('sales', { from: '01-09-2026' })).status).toBe(400);
      // Una dimensión que no existe en ningún reporte ni llega al dominio.
      expect((await get('sales', { groupBy: 'nombre; DROP TABLE x' })).status).toBe(400);
      expect((await get('sales', { from: '2026-09-30', to: '2026-09-01' })).status).toBe(422);
    });

    it('otro tenant no ve estos datos', async () => {
      const other = await createTenant(db);
      const res = await get('sales', {}, `Bearer ${tokenFor(other, ALL)}`);
      expect(res.body.totals.orders).toBe(0);
    });
  });

  describe('exportes', () => {
    const exportsService = () => app.get(ExportService);
    const runWorker = () => exportsService().processDue(new Date(), 10, t.tenantId);

    async function requestExport(body: Record<string, unknown>, auth = bearer) {
      return http().post('/v1/reports/exports').set('Authorization', auth).send({ ...RANGE, ...body });
    }

    it('Excel: se encola (202), el worker lo genera y se descarga desde el almacenamiento', async () => {
      const created = await requestExport({ report: 'sales', format: 'xlsx', groupBy: 'payment_method' });
      expect(created.status).toBe(202);
      expect(created.body).toMatchObject({ status: 'queued', report: 'sales', format: 'xlsx', params: { ...RANGE, groupBy: 'payment_method' } });
      const id = created.body.id as string;

      const early = await http().get(`/v1/reports/exports/${id}/download`).set('Authorization', bearer);
      expect(early.status).toBe(409);
      expect(early.body).toMatchObject({ error: { code: 'EXPORT_NOT_READY', details: { status: 'queued' } } });

      expect(await runWorker()).toEqual({ claimed: 1, done: 1, failed: 0 });
      const status = await http().get(`/v1/reports/exports/${id}`).set('Authorization', bearer);
      expect(status.body).toMatchObject({
        status: 'done', rowCount: 2, filename: 'reporte-sales-payment-method-2026-09-01-a-2026-09-30.xlsx', expiresAt: expect.any(String),
      });

      const file = await http().get(`/v1/reports/exports/${id}/download`).set('Authorization', bearer).buffer(true).parse(binary);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toContain('spreadsheetml');
      expect(file.headers['content-disposition']).toContain('attachment; filename="reporte-sales-payment-method');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.body as unknown as ArrayBuffer);
      const ws = wb.getWorksheet('Reporte')!;
      expect(ws.getRow(6).getCell(1).value).toBe('Tarjeta');
      expect(ws.getRow(8).getCell(1).value).toBe('Total');
      expect(ws.getRow(8).getCell(2).value).toBe(3);

      const mine = await http().get('/v1/reports/exports').set('Authorization', bearer);
      expect(mine.body.map((e: { id: string }) => e.id)).toContain(id);
    });

    it('PDF de entregas por motorizado', async () => {
      const created = await requestExport({ report: 'delivery', format: 'pdf', groupBy: 'rider' });
      await runWorker();
      const file = await http().get(`/v1/reports/exports/${created.body.id}/download`).set('Authorization', bearer).buffer(true).parse(binary);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toBe('application/pdf');
      expect((file.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });

    it('si falla el almacenamiento se reintenta en la siguiente pasada', async () => {
      const created = await requestExport({ report: 'funnel', format: 'xlsx' });
      const put = jest.spyOn(app.get(ReportStorage), 'put').mockRejectedValueOnce(new Error('SeaweedFS respondió 503'));
      expect(await runWorker()).toEqual({ claimed: 1, done: 0, failed: 1 });
      const after = await http().get(`/v1/reports/exports/${created.body.id}`).set('Authorization', bearer);
      expect(after.body).toMatchObject({ status: 'queued', error: 'SeaweedFS respondió 503' });
      expect(await runWorker()).toEqual({ claimed: 1, done: 1, failed: 0 });
      put.mockRestore();
    });

    it('exige reports.export y el permiso de lectura del reporte; otro tenant no lo ve', async () => {
      const noExport = `Bearer ${tokenFor(t, ['reports.sales.read'])}`;
      expect((await requestExport({ report: 'sales', format: 'pdf' }, noExport)).status).toBe(403);
      const noDelivery = `Bearer ${tokenFor(t, ['reports.export', 'reports.sales.read'])}`;
      expect((await requestExport({ report: 'delivery', format: 'pdf' }, noDelivery)).status).toBe(403);
      expect((await requestExport({ report: 'sales', format: 'csv' })).status).toBe(400);
      expect((await requestExport({ report: 'funnel', format: 'pdf', groupBy: 'rider' })).status).toBe(422);

      const created = await requestExport({ report: 'sales', format: 'pdf' });
      const other = await createTenant(db);
      const res = await http().get(`/v1/reports/exports/${created.body.id}`).set('Authorization', `Bearer ${tokenFor(other, ALL)}`);
      expect(res.status).toBe(404);
      await runWorker();
    });

    it('ver y descargar exige ser quien lo pidió y conservar el permiso del reporte; queda en la auditoría', async () => {
      const created = await requestExport({ report: 'delivery', format: 'xlsx' });
      expect(created.status).toBe(202);
      await runWorker();
      const id = created.body.id as string;

      // Otro usuario del mismo tenant, aunque tenga todos los permisos: 404 (no es suyo).
      const colleague = `Bearer ${tokenFor({ ...t, userId: randomUUID() }, ALL)}`;
      expect((await http().get(`/v1/reports/exports/${id}`).set('Authorization', colleague)).status).toBe(404);
      expect((await http().get(`/v1/reports/exports/${id}/download`).set('Authorization', colleague)).status).toBe(404);
      expect((await http().get('/v1/reports/exports').set('Authorization', colleague)).body).toEqual([]);

      // El mismo usuario sin reports.delivery.read (se lo quitaron después de pedirlo): 403.
      const lostRead = `Bearer ${tokenFor(t, ['reports.export', 'reports.sales.read'])}`;
      expect((await http().get(`/v1/reports/exports/${id}`).set('Authorization', lostRead)).status).toBe(403);
      expect((await http().get(`/v1/reports/exports/${id}/download`).set('Authorization', lostRead)).status).toBe(403);

      expect((await http().get(`/v1/reports/exports/${id}/download`).set('Authorization', bearer).buffer(true).parse(binary)).status).toBe(200);
      const audit = await db.query(
        `SELECT action, after->>'outcome' AS outcome FROM platform.audit_log WHERE entity_type = 'report_export' AND entity_id = $1 ORDER BY id`,
        [id],
      );
      expect(audit.rows).toEqual([
        { action: 'reports.export.create', outcome: 'ok' },
        { action: 'reports.export.download', outcome: 'failed' },
        { action: 'reports.export.download', outcome: 'denied' },
        { action: 'reports.export.download', outcome: 'ok' },
      ]);
    });
  });
});
