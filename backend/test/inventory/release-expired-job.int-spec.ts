import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue, QueueEvents } from 'bullmq';
import { WorkerModule } from '../../apps/worker/worker.module';
import { InventoryApi } from '../../libs/modules/inventory';
// El caso de uso y las constantes del job no son API pública; el test los toma de los internos.
import { ReservationService } from '../../libs/modules/inventory/application/reservation.service';
import {
  INVENTORY_QUEUE,
  RELEASE_EXPIRED_EVERY_MS,
  RELEASE_EXPIRED_RESERVATIONS,
} from '../../libs/modules/inventory/infrastructure/jobs/release-expired-reservations.job';
import { connectionFromUrl, Database } from '../../libs/shared-kernel';
import { createTenant, createVariants, createWarehouse, getStock, setStock, TestTenant } from '../support/fixtures';

/** Levanta el proceso worker real (BullMQ sobre el Valkey de Testcontainers). */
describe('Inventario · job de liberación de reservas vencidas', () => {
  let worker: TestingModule;
  let db: Database;
  let inventory: InventoryApi;
  let queue: Queue;
  let events: QueueEvents;
  let t: TestTenant;
  let warehouseId: string;

  beforeAll(async () => {
    worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    worker.useLogger(['error', 'warn']);
    await worker.init(); // dispara onApplicationBootstrap: registra el scheduler y arranca el Worker
    db = worker.get(Database);
    inventory = worker.get(InventoryApi);

    const connection = connectionFromUrl(process.env.VALKEY_URL!);
    queue = new Queue(INVENTORY_QUEUE, { connection });
    events = new QueueEvents(INVENTORY_QUEUE, { connection });
    await events.waitUntilReady();

    t = await createTenant(db);
    warehouseId = await createWarehouse(db, t.tenantId);
  });

  afterAll(async () => {
    await events?.close();
    await queue?.close();
    await worker?.close();
  });

  const reserve = async (variantId: string, quantity: number) => {
    const orderId = randomUUID();
    await inventory.reserveStock({ tenantId: t.tenantId, orderId, lines: [{ variantId, warehouseId, quantity }] });
    return orderId;
  };

  const expire = (orderIds: string[]) =>
    db.query(
      `UPDATE inventory.stock_reservations SET expires_at = now() - interval '1 second' WHERE order_id = ANY($1::uuid[])`,
      [orderIds],
    );

  it('registra un único scheduler que corre cada minuto', async () => {
    const ours = (await queue.getJobSchedulers()).filter((s) => s.key === RELEASE_EXPIRED_RESERVATIONS);
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ name: RELEASE_EXPIRED_RESERVATIONS, every: RELEASE_EXPIRED_EVERY_MS });
  });

  it('el worker procesa el job y libera solo las reservas vencidas', async () => {
    const [v] = await createVariants(db, t.tenantId, 1);
    await setStock(db, v, warehouseId, 10);
    const expiredOrder = await reserve(v, 3);
    const liveOrder = await reserve(v, 2);
    await expire([expiredOrder]);
    expect(await getStock(db, v, warehouseId)).toMatchObject({ reserved: 5 });

    // En lugar de esperar al próximo minuto, se encola una ejecución inmediata del mismo job.
    const job = await queue.add(RELEASE_EXPIRED_RESERVATIONS, {});
    await job.waitUntilFinished(events, 30_000);

    expect(await getStock(db, v, warehouseId)).toMatchObject({ on_hand: 10, reserved: 2, available: 8 });
    const { rows } = await db.query<{ order_id: string; status: string }>(
      `SELECT order_id, status FROM inventory.stock_reservations WHERE variant_id = $1`,
      [v],
    );
    expect(Object.fromEntries(rows.map((r) => [r.order_id, r.status]))).toEqual({
      [expiredOrder]: 'released',
      [liveOrder]: 'active',
    });
  });

  it('dos réplicas liberando a la vez no liberan dos veces la misma reserva (SKIP LOCKED)', async () => {
    const [v] = await createVariants(db, t.tenantId, 1);
    await setStock(db, v, warehouseId, 50);
    const orders: string[] = [];
    for (let i = 0; i < 20; i++) orders.push(await reserve(v, 1));
    await expire(orders);

    // Lotes pequeños para forzar que ambas ejecuciones se intercalen.
    const reservations = worker.get(ReservationService);
    await Promise.all([reservations.releaseExpired(3), reservations.releaseExpired(3)]);

    // Si una reserva se liberara dos veces, reserved quedaría negativo y el CHECK abortaría la
    // transacción (Promise.all fallaría). El total liberado no se compara: el scheduler del
    // worker también puede estar liberando en paralelo, que es justo el escenario real.
    expect(await getStock(db, v, warehouseId)).toMatchObject({ on_hand: 50, reserved: 0, available: 50 });
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM inventory.stock_reservations WHERE variant_id = $1 AND status = 'released'`,
      [v],
    );
    expect(rows[0].n).toBe(20);
  });
});
