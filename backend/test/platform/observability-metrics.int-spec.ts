import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { AggregationTemporality, DataPoint, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { Queue } from 'bullmq';
import { BillingMetrics } from '../../libs/modules/billing/infrastructure/billing-metrics';
import { connectionFromUrl, Database, OutboxRelay, QueueMetrics } from '../../libs/shared-kernel';
import { createEmissionPoint, createTenant, TestTenant } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

/**
 * Métricas propias que alimentan el dashboard "Moda · Operación" y las alertas, leídas con un
 * MeterProvider en memoria (en producción las exporta el SDK por OTLP a Prometheus):
 *  - outbox.events.published{event_type} (pedidos por minuto = OrderPlaced)
 *  - bullmq.queue.jobs{queue,state} (profundidad de las colas)
 *  - sri.documents.pending / .pending.oldest_age / .rejected (facturación)
 */
describe('Observabilidad: métricas de outbox, colas y facturación', () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const provider = new MeterProvider({ readers: [reader] });
  let app: INestApplication;
  let db: Database;
  let relay: OutboxRelay;
  let t: TestTenant;

  beforeAll(async () => {
    // Antes de crear la app: los contadores se crean en el constructor de OutboxRelay.
    metrics.setGlobalMeterProvider(provider);
    ({ app, db, relay } = await createTestApp());
    t = await createTenant(db);
  });

  afterAll(async () => {
    await app.close();
    await provider.shutdown();
    metrics.disable();
  });

  async function collect(): Promise<ResourceMetrics> {
    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    return resourceMetrics;
  }

  function points(rm: ResourceMetrics, name: string): DataPoint<number>[] {
    const found = rm.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
    return (found?.dataPoints ?? []) as DataPoint<number>[];
  }

  it('el relay cuenta cada evento publicado por event_type', async () => {
    const eventType = `PruebaObservabilidad${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO platform.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, event_version, payload)
         VALUES ($1, 'prueba', $2, $3, 1, '{}')`,
        [t.tenantId, randomUUID(), eventType],
      );
    }
    await relay.drain({ tenantId: t.tenantId });

    const published = points(await collect(), 'outbox.events.published').find((p) => p.attributes.event_type === eventType);
    expect(published?.value).toBe(3);
  });

  it('la profundidad de las colas se descubre en Valkey y se reporta por estado', async () => {
    const name = `obs-prueba-${randomUUID().slice(0, 8)}`;
    const connection = connectionFromUrl(process.env.VALKEY_URL!);
    const queue = new Queue(name, { connection });
    const gauge = new QueueMetrics(connection);
    gauge.onModuleInit();
    try {
      await queue.addBulk([{ name: 'a', data: {} }, { name: 'b', data: {} }]);
      await queue.add('despues', {}, { delay: 60_000 });

      expect(await gauge.discover()).toContain(name);
      const byState = (await gauge.counts())[name];
      expect(byState).toMatchObject({ waiting: 2, delayed: 1, active: 0, failed: 0 });

      const series = points(await collect(), 'bullmq.queue.jobs').filter((p) => p.attributes.queue === name);
      expect(series.find((p) => p.attributes.state === 'waiting')?.value).toBe(2);
      expect(series.find((p) => p.attributes.state === 'delayed')?.value).toBe(1);
    } finally {
      await gauge.onModuleDestroy();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('cuenta los comprobantes pendientes con el SRI, el más viejo y los rechazados de las últimas 24 h', async () => {
    const point = await createEmissionPoint(db, t.tenantId);
    const insert = (seq: number, status: string, ageHours: number) =>
      db.query(
        `INSERT INTO billing.electronic_documents
           (tenant_id, doc_type, emission_point_id, sequential, access_key, environment, issue_date,
            buyer_id_type, buyer_id, buyer_name, total, payment_forms, status, created_at)
         VALUES ($1, '01', $2, $3, $4, 1, current_date, '07', '9999999999999', 'CONSUMIDOR FINAL', 10, '[]', $5,
                 now() - make_interval(hours => $6))`,
        [t.tenantId, point, seq, randomUUID().replace(/-/g, '').padEnd(49, '0').slice(0, 49), status, ageHours],
      );
    await insert(1, 'pending', 2);
    await insert(2, 'signed', 0);
    await insert(3, 'returned', 1);
    await insert(4, 'authorized', 0); // ya no cuenta
    const billing = new BillingMetrics(db);
    billing.onModuleInit();
    try {
      // La base es compartida con otros archivos de tests: los conteos son "al menos".
      const rows = await billing.summary();
      const count = (status: string) => rows.filter((r) => r.status === status && r.doc_type === '01').reduce((n, r) => n + r.count, 0);
      expect(count('pending')).toBeGreaterThanOrEqual(1);
      expect(count('signed')).toBeGreaterThanOrEqual(1);
      expect(count('returned')).toBeGreaterThanOrEqual(1);
      expect(rows.some((r) => r.status === 'authorized')).toBe(false);

      const rm = await collect();
      const pending = points(rm, 'sri.documents.pending');
      expect(pending.find((p) => p.attributes.status === 'pending' && p.attributes.doc_type === '01')?.value).toBeGreaterThanOrEqual(1);
      expect(points(rm, 'sri.documents.pending.oldest_age')[0]?.value).toBeGreaterThanOrEqual(2 * 3600 - 60);
      expect(points(rm, 'sri.documents.rejected').find((p) => p.attributes.status === 'returned')?.value).toBeGreaterThanOrEqual(1);
    } finally {
      billing.onModuleDestroy();
    }
  });
});
