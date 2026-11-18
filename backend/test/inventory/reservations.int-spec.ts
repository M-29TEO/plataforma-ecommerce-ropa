import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import {
  InsufficientStockError,
  InventoryApi,
  OrderAlreadyReservedError,
  ReservationExpiredError,
  ReservationNotFoundError,
  STOCK_BELOW_THRESHOLD,
  WarehouseInactiveError,
} from '../../libs/modules/inventory';
import { Database } from '../../libs/shared-kernel';
import {
  createTenant,
  createVariants,
  createWarehouse,
  getStock,
  outboxEvents,
  setStock,
  TestTenant,
} from '../support/fixtures';
import { createTestApp } from '../support/test-app';

describe('Inventario · reservas de stock', () => {
  let app: INestApplication;
  let db: Database;
  let inventory: InventoryApi;
  let t: TestTenant;
  let warehouseId: string;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    inventory = app.get(InventoryApi);
    t = await createTenant(db);
    warehouseId = await createWarehouse(db, t.tenantId);
  });

  afterAll(async () => {
    await app.close();
  });

  const expireReservations = (orderId: string) =>
    db.query(`UPDATE inventory.stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = $1`, [
      orderId,
    ]);

  describe('ReserveStock', () => {
    it('reserva todas las líneas y sube reserved sin tocar on_hand', async () => {
      const [a, b] = await createVariants(db, t.tenantId, 2);
      await setStock(db, a, warehouseId, 10);
      await setStock(db, b, warehouseId, 5);
      const orderId = randomUUID();

      const result = await inventory.reserveStock({
        tenantId: t.tenantId,
        orderId,
        lines: [
          { variantId: a, warehouseId, quantity: 2 },
          { variantId: b, warehouseId, quantity: 1 },
          { variantId: a, warehouseId, quantity: 1 }, // línea repetida: se agrupa
        ],
      });

      expect(result.alreadyReserved).toBe(false);
      expect(result.reservations).toHaveLength(2);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(await getStock(db, a, warehouseId)).toMatchObject({ on_hand: 10, reserved: 3, available: 7 });
      expect(await getStock(db, b, warehouseId)).toMatchObject({ on_hand: 5, reserved: 1, available: 4 });
    });

    it('es todo o nada: si una línea no alcanza, no queda ninguna reservada', async () => {
      const [a, b] = await createVariants(db, t.tenantId, 2);
      await setStock(db, a, warehouseId, 10);
      await setStock(db, b, warehouseId, 1);
      const orderId = randomUUID();

      await expect(
        inventory.reserveStock({
          tenantId: t.tenantId,
          orderId,
          lines: [
            { variantId: a, warehouseId, quantity: 4 },
            { variantId: b, warehouseId, quantity: 2 },
          ],
        }),
      ).rejects.toBeInstanceOf(InsufficientStockError);

      expect(await getStock(db, a, warehouseId)).toMatchObject({ reserved: 0 });
      expect(await getStock(db, b, warehouseId)).toMatchObject({ reserved: 0 });
      expect(await inventory.releaseReservation(t.tenantId, orderId)).toEqual({ released: 0 });
    });

    it('falla si la variante no tiene fila de stock en la bodega', async () => {
      const [a] = await createVariants(db, t.tenantId, 1);
      await expect(
        inventory.reserveStock({
          tenantId: t.tenantId,
          orderId: randomUUID(),
          lines: [{ variantId: a, warehouseId, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(InsufficientStockError);
    });

    it('rechaza bodegas inactivas o de otro tenant', async () => {
      const [a] = await createVariants(db, t.tenantId, 1);
      const inactive = await createWarehouse(db, t.tenantId, { active: false });
      await setStock(db, a, inactive, 10);
      await expect(
        inventory.reserveStock({
          tenantId: t.tenantId,
          orderId: randomUUID(),
          lines: [{ variantId: a, warehouseId: inactive, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(WarehouseInactiveError);

      const other = await createTenant(db);
      await setStock(db, a, warehouseId, 10);
      await expect(
        inventory.reserveStock({
          tenantId: other.tenantId,
          orderId: randomUUID(),
          lines: [{ variantId: a, warehouseId, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(WarehouseInactiveError);
    });

    it('es idempotente por pedido: un reintento con las mismas líneas no reserva dos veces', async () => {
      const [a] = await createVariants(db, t.tenantId, 1);
      await setStock(db, a, warehouseId, 10);
      const orderId = randomUUID();
      const lines = [{ variantId: a, warehouseId, quantity: 2 }];

      const first = await inventory.reserveStock({ tenantId: t.tenantId, orderId, lines });
      const retry = await inventory.reserveStock({ tenantId: t.tenantId, orderId, lines });

      expect(retry.alreadyReserved).toBe(true);
      expect(retry.reservations.map((r) => r.id)).toEqual(first.reservations.map((r) => r.id));
      expect(await getStock(db, a, warehouseId)).toMatchObject({ reserved: 2 });

      await expect(
        inventory.reserveStock({ tenantId: t.tenantId, orderId, lines: [{ variantId: a, warehouseId, quantity: 3 }] }),
      ).rejects.toBeInstanceOf(OrderAlreadyReservedError);
    });

    it('si la reserva previa del pedido venció, la libera y reserva de nuevo', async () => {
      const [a] = await createVariants(db, t.tenantId, 1);
      await setStock(db, a, warehouseId, 10);
      const orderId = randomUUID();
      const lines = [{ variantId: a, warehouseId, quantity: 2 }];
      await inventory.reserveStock({ tenantId: t.tenantId, orderId, lines });
      await expireReservations(orderId);

      const again = await inventory.reserveStock({ tenantId: t.tenantId, orderId, lines });

      expect(again.alreadyReserved).toBe(false);
      expect(await getStock(db, a, warehouseId)).toMatchObject({ reserved: 2 });
    });
  });

  describe('Concurrencia', () => {
    it('10 reservas simultáneas compiten por 3 unidades: exactamente 3 ganan', async () => {
      const [variantId] = await createVariants(db, t.tenantId, 1);
      await setStock(db, variantId, warehouseId, 3);

      // Cada llamada abre su propia transacción en una conexión distinta del pool.
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          inventory.reserveStock({
            tenantId: t.tenantId,
            orderId: randomUUID(),
            lines: [{ variantId, warehouseId, quantity: 1 }],
          }),
        ),
      );

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(won).toHaveLength(3);
      expect(lost).toHaveLength(7);
      for (const r of lost) expect(r.reason).toBeInstanceOf(InsufficientStockError);

      expect(await getStock(db, variantId, warehouseId)).toMatchObject({ on_hand: 3, reserved: 3, available: 0 });
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM inventory.stock_reservations WHERE variant_id = $1 AND status = 'active'`,
        [variantId],
      );
      expect(rows[0].n).toBe(3);
    });

    it('pedidos con las mismas variantes en orden inverso no producen deadlocks', async () => {
      const [a, b, c] = await createVariants(db, t.tenantId, 3);
      for (const v of [a, b, c]) await setStock(db, v, warehouseId, 100);

      // Sin ordenar por variant_id, [a,b,c] contra [c,b,a] en paralelo genera ciclos de espera (40P01).
      const orders = Array.from({ length: 20 }, (_, i) => {
        const variants = i % 2 === 0 ? [a, b, c] : [c, b, a];
        return inventory.reserveStock({
          tenantId: t.tenantId,
          orderId: randomUUID(),
          lines: variants.map((variantId) => ({ variantId, warehouseId, quantity: 1 })),
        });
      });

      const results = await Promise.allSettled(orders);
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
      expect(errors).toEqual([]);
      for (const v of [a, b, c]) expect(await getStock(db, v, warehouseId)).toMatchObject({ reserved: 20 });
    });
  });

  describe('StockBelowThreshold', () => {
    it('se emite al cruzar el punto de reorden y no se repite en cada reserva posterior', async () => {
      const [variantId] = await createVariants(db, t.tenantId, 1);
      await setStock(db, variantId, warehouseId, 6, { reorderPoint: 3 });
      const reserveOne = () =>
        inventory.reserveStock({
          tenantId: t.tenantId,
          orderId: randomUUID(),
          lines: [{ variantId, warehouseId, quantity: 1 }],
        });

      await reserveOne(); // disponible 5 → sin evento
      await reserveOne(); // 4 → sin evento
      await reserveOne(); // 3 → cruza: evento
      await reserveOne(); // 2 → ya estaba por debajo: sin evento

      const events = (await outboxEvents(db, t.tenantId, STOCK_BELOW_THRESHOLD)).filter(
        (e) => e.payload.variantId === variantId,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregate_id: variantId,
        payload: { variantId, warehouseId, available: 3, reorderPoint: 3, cause: 'reservation' },
      });
    });

    it('si la reserva falla, el evento no queda en el outbox (misma transacción)', async () => {
      const [a, b] = await createVariants(db, t.tenantId, 2);
      await setStock(db, a, warehouseId, 4, { reorderPoint: 3 });
      await setStock(db, b, warehouseId, 0);

      await expect(
        inventory.reserveStock({
          tenantId: t.tenantId,
          orderId: randomUUID(),
          lines: [
            { variantId: a, warehouseId, quantity: 2 }, // cruzaría el umbral
            { variantId: b, warehouseId, quantity: 1 }, // sin stock → ROLLBACK
          ],
        }),
      ).rejects.toBeInstanceOf(InsufficientStockError);

      const events = (await outboxEvents(db, t.tenantId, STOCK_BELOW_THRESHOLD)).filter((e) => e.payload.variantId === a);
      expect(events).toHaveLength(0);
    });
  });

  describe('ConfirmReservation', () => {
    it('baja on_hand y reserved, marca consumed y escribe un movimiento sale', async () => {
      const [a] = await createVariants(db, t.tenantId, 1);
      await setStock(db, a, warehouseId, 10);
      const orderId = randomUUID();
      await inventory.reserveStock({ tenantId: t.tenantId, orderId, lines: [{ variantId: a, warehouseId, quantity: 4 }] });

      const consumed = await inventory.confirmReservation(t.tenantId, orderId);

      expect(consumed.every((r) => r.status === 'consumed')).toBe(true);
      expect(await getStock(db, a, warehouseId)).toMatchObject({ on_hand: 6, reserved: 0, available: 6 });
      const { rows } = await db.query(
        `SELECT quantity, movement_type, reference_type, reference_id FROM inventory.stock_movements WHERE variant_id = $1`,
        [a],
      );
      expect(rows).toEqual([{ quantity: -4, movement_type: 'sale', reference_type: 'order', reference_id: orderId }]);
      await expect(inventory.confirmReservation(t.tenantId, orderId)).rejects.toBeInstanceOf(ReservationNotFoundError);
    });

    it('rechaza reservas vencidas', async () => {
      const [a] = await createVariants(db, t.tenantId, 1);
      await setStock(db, a, warehouseId, 10);
      const orderId = randomUUID();
      await inventory.reserveStock({ tenantId: t.tenantId, orderId, lines: [{ variantId: a, warehouseId, quantity: 1 }] });
      await expireReservations(orderId);

      await expect(inventory.confirmReservation(t.tenantId, orderId)).rejects.toBeInstanceOf(ReservationExpiredError);
      expect(await getStock(db, a, warehouseId)).toMatchObject({ on_hand: 10, reserved: 1 });
    });
  });

  describe('ReleaseReservation', () => {
    it('devuelve las unidades al disponible y es idempotente', async () => {
      const [a] = await createVariants(db, t.tenantId, 1);
      await setStock(db, a, warehouseId, 5);
      const orderId = randomUUID();
      await inventory.reserveStock({ tenantId: t.tenantId, orderId, lines: [{ variantId: a, warehouseId, quantity: 5 }] });

      expect(await inventory.releaseReservation(t.tenantId, orderId)).toEqual({ released: 1 });
      expect(await inventory.releaseReservation(t.tenantId, orderId)).toEqual({ released: 0 });
      expect(await getStock(db, a, warehouseId)).toMatchObject({ on_hand: 5, reserved: 0 });
      // La liberación no es un movimiento físico: el ledger no cambia.
      const { rows } = await db.query(`SELECT 1 FROM inventory.stock_movements WHERE variant_id = $1`, [a]);
      expect(rows).toHaveLength(0);
    });
  });

  describe('Disponibilidad', () => {
    it('suma el disponible de bodegas activas que despachan online', async () => {
      const [a, b] = await createVariants(db, t.tenantId, 2);
      const store = await createWarehouse(db, t.tenantId, { shipsOnline: false });
      await setStock(db, a, warehouseId, 7, { reserved: 2 });
      await setStock(db, a, store, 50);

      const availability = await inventory.getAvailability(t.tenantId, [a, b]);

      expect(availability.get(a)).toBe(5);
      expect(availability.get(b)).toBe(0);
    });
  });
});
