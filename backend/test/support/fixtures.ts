/**
 * Datos de prueba. Los tests pueden escribir en otros schemas (iam, catalog) porque solo
 * preparan las FK que exige el modelo; el código de producción de Inventario no lo hace.
 * Cada archivo de test crea su propio tenant, así los archivos no se pisan entre sí.
 */
import { randomUUID } from 'node:crypto';
import { Queryable, signAccessToken } from '../../libs/shared-kernel';

export const INVENTORY_PERMISSIONS = [
  'inventory.read',
  'inventory.warehouse.write',
  'inventory.stock.write',
  'inventory.adjust',
  'inventory.supplier.write',
  'inventory.purchase.write',
  'inventory.purchase.receive',
];

export interface TestTenant {
  tenantId: string;
  userId: string;
}

export async function createTenant(db: Queryable): Promise<TestTenant> {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO iam.tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [slug, `Tenant ${slug}`],
  );
  const tenantId = rows[0].id;
  const user = await db.query<{ id: string }>(
    `INSERT INTO iam.users (tenant_id, user_type, email) VALUES ($1, 'staff', $2) RETURNING id`,
    [tenantId, `bodega+${slug}@example.test`],
  );
  return { tenantId, userId: user.rows[0].id };
}

/** Crea una categoría, un producto y `count` variantes; devuelve los ids de las variantes. */
export async function createVariants(db: Queryable, tenantId: string, count: number): Promise<string[]> {
  const tag = randomUUID().slice(0, 8);
  const category = await db.query<{ id: string }>(
    `INSERT INTO catalog.categories (tenant_id, name, slug, path) VALUES ($1, 'Camisetas', $2, $2) RETURNING id`,
    [tenantId, `camisetas-${tag}`],
  );
  const product = await db.query<{ id: string }>(
    `INSERT INTO catalog.products (tenant_id, category_id, name, slug, gender, base_price)
     VALUES ($1, $2, 'Camiseta básica', $3, 'unisex', 19.90) RETURNING id`,
    [tenantId, category.rows[0].id, `camiseta-${tag}`],
  );
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const v = await db.query<{ id: string }>(
      `INSERT INTO catalog.product_variants (product_id, sku) VALUES ($1, $2) RETURNING id`,
      [product.rows[0].id, `SKU-${tag}-${i}`],
    );
    ids.push(v.rows[0].id);
  }
  return ids;
}

/** Inserta una bodega directamente (para tests que no prueban el CRUD). Quito: -0.1807, -78.4678. */
export async function createWarehouse(
  db: Queryable,
  tenantId: string,
  opts: { code?: string; lat?: number; lng?: number; active?: boolean; shipsOnline?: boolean } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO inventory.warehouses (tenant_id, code, name, type, address, location, city, active, ships_online)
     VALUES ($1, $2, 'Bodega de prueba', 'warehouse', '{}'::jsonb,
             ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 'Quito', $5, $6)
     RETURNING id`,
    [
      tenantId,
      opts.code ?? `WH-${randomUUID().slice(0, 6)}`,
      opts.lng ?? -78.4678,
      opts.lat ?? -0.1807,
      opts.active ?? true,
      opts.shipsOnline ?? true,
    ],
  );
  return rows[0].id;
}

export async function setStock(
  db: Queryable,
  variantId: string,
  warehouseId: string,
  onHand: number,
  opts: { reserved?: number; reorderPoint?: number } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO inventory.stock_levels (variant_id, warehouse_id, on_hand, reserved, reorder_point)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (variant_id, warehouse_id)
       DO UPDATE SET on_hand = EXCLUDED.on_hand, reserved = EXCLUDED.reserved, reorder_point = EXCLUDED.reorder_point`,
    [variantId, warehouseId, onHand, opts.reserved ?? 0, opts.reorderPoint ?? 3],
  );
}

export async function getStock(db: Queryable, variantId: string, warehouseId: string) {
  const { rows } = await db.query<{ on_hand: number; reserved: number; available: number; version: number }>(
    `SELECT on_hand, reserved, available, version FROM inventory.stock_levels WHERE variant_id = $1 AND warehouse_id = $2`,
    [variantId, warehouseId],
  );
  return rows[0];
}

export async function outboxEvents(db: Queryable, tenantId: string, eventType: string) {
  const { rows } = await db.query<{ aggregate_id: string; payload: Record<string, unknown> }>(
    `SELECT aggregate_id, payload FROM platform.outbox_events WHERE tenant_id = $1 AND event_type = $2 ORDER BY id`,
    [tenantId, eventType],
  );
  return rows;
}

export function tokenFor(t: TestTenant, permissions: string[] = INVENTORY_PERMISSIONS): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET no definido (¿corrió global-setup?)');
  return signAccessToken({ id: t.userId, tenantId: t.tenantId, type: 'staff', permissions }, secret);
}

export const ORDER_PERMISSIONS = ['orders.read', 'orders.status.update', 'orders.cancel', 'orders.payment.confirm'];

/** Cliente final del tenant (iam.users con user_type 'customer'). */
export async function createCustomer(db: Queryable, tenantId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO iam.users (tenant_id, user_type, email) VALUES ($1, 'customer', $2) RETURNING id`,
    [tenantId, `cliente+${randomUUID().slice(0, 8)}@example.test`],
  );
  return rows[0].id;
}

export function customerTokenFor(tenantId: string, customerId: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET no definido (¿corrió global-setup?)');
  return signAccessToken({ id: customerId, tenantId, type: 'customer', permissions: [] }, secret);
}

export const PROMOTION_PERMISSIONS = ['promotions.read', 'promotions.write', 'giftcards.read', 'giftcards.write'];

export interface SellableSpec {
  /** base_price del producto (sin IVA). */
  price: string;
  /** Código de IVA del SRI; por defecto '4' (15 %). */
  taxCode?: string;
  categoryPath?: string;
  /** 'draft' = no se puede vender. */
  status?: 'active' | 'draft';
  name?: string;
}

/** Producto ACTIVO con una variante (lo que el carrito puede vender). Devuelve ids. */
export async function createSellableVariant(
  db: Queryable,
  tenantId: string,
  spec: SellableSpec,
): Promise<{ variantId: string; productId: string }> {
  const tag = randomUUID().slice(0, 8);
  const path = spec.categoryPath ?? 'unisex/camisetas';
  const category = await db.query<{ id: string }>(
    `INSERT INTO catalog.categories (tenant_id, name, slug, path) VALUES ($1, $2, $3, $2)
     ON CONFLICT (tenant_id, path) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [tenantId, path, `cat-${tag}`],
  );
  const product = await db.query<{ id: string }>(
    `INSERT INTO catalog.products (tenant_id, category_id, name, slug, gender, base_price, tax_code, status)
     VALUES ($1, $2, $3, $4, 'unisex', $5, $6, $7) RETURNING id`,
    [tenantId, category.rows[0].id, spec.name ?? `Producto ${tag}`, `prod-${tag}`, spec.price, spec.taxCode ?? '4', spec.status ?? 'active'],
  );
  const variant = await db.query<{ id: string }>(
    `INSERT INTO catalog.product_variants (product_id, sku) VALUES ($1, $2) RETURNING id`,
    [product.rows[0].id, `SKU-${tag}`],
  );
  return { variantId: variant.rows[0].id, productId: product.rows[0].id };
}

export const SETTLEMENT_PERMISSIONS = ['logistics.read', 'logistics.settlement.manage', 'logistics.settlement.approve'];

/** Motorizado del tenant: usuario 'rider' en iam.users + fila en logistics.riders. */
export async function createRider(
  db: Queryable,
  tenantId: string,
  opts: { commissionScheme?: object; codLimit?: string; codBalance?: string } = {},
): Promise<{ riderId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO iam.users (tenant_id, user_type, email) VALUES ($1, 'rider', $2) RETURNING id`,
    [tenantId, `moto+${randomUUID().slice(0, 8)}@example.test`],
  );
  const rider = await db.query<{ id: string }>(
    `INSERT INTO logistics.riders (user_id, tenant_id, vehicle_type, commission_scheme, cod_limit, cod_balance)
     VALUES ($1, $2, 'motorcycle', COALESCE($3::jsonb, '{"per_delivery":2.50,"per_km":0.30}'), $4, $5) RETURNING id`,
    [user.rows[0].id, tenantId, opts.commissionScheme ? JSON.stringify(opts.commissionScheme) : null, opts.codLimit ?? '200.00', opts.codBalance ?? '0.00'],
  );
  return { riderId: rider.rows[0].id, userId: user.rows[0].id };
}

export function riderTokenFor(tenantId: string, userId: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET no definido (¿corrió global-setup?)');
  return signAccessToken({ id: userId, tenantId, type: 'rider', permissions: [] }, secret);
}

/**
 * Envío ya entregado por un motorizado, insertado directo en su estado final (atajo para los tests de
 * calificaciones y liquidaciones; el flujo completo está en test/logistics/rider-app.int-spec.ts).
 */
export async function createRiderShipment(
  db: Queryable,
  s: {
    tenantId: string;
    orderId: string;
    riderId: string | null;
    deliveredAt?: Date | null;
    status?: string;
    carrierType?: 'rider' | 'courier';
    distanceM?: number | null;
    codMethod?: 'cash' | 'card_pos' | 'deuna_qr' | null;
    codCollected?: string | null;
  },
): Promise<string> {
  const deliveredAt = s.deliveredAt === undefined ? new Date() : s.deliveredAt;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO logistics.shipments
       (tenant_id, order_id, carrier_type, rider_id, tracking_token, status, destination, weight_g, distance_m,
        cod_amount, cod_collected, cod_method, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 800, $7, COALESCE($8::numeric, 0), $8::numeric, $9, $10) RETURNING id`,
    [
      s.tenantId,
      s.orderId,
      s.carrierType ?? 'rider',
      s.riderId,
      `trk-${randomUUID()}`,
      s.status ?? 'delivered',
      s.distanceM === undefined ? 3000 : s.distanceM,
      s.codCollected ?? null,
      s.codMethod ?? null,
      deliveredAt,
    ],
  );
  return rows[0].id;
}

export const BILLING_PERMISSIONS = ['billing.read'];

/**
 * Punto de emisión 001-001 (ambiente de pruebas) con sus secuenciales de facturas (01) y notas de
 * crédito (04): sin esto, los consumidores de OrderPaid y RefundSucceeded no pueden emitir
 * (EMISSION_POINT_NOT_CONFIGURED).
 */
export async function createEmissionPoint(db: Queryable, tenantId: string, lastValue = 0): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO billing.emission_points (tenant_id, establishment, emission_point, address, environment)
     VALUES ($1, '001', '001', 'Tienda en línea - Av. Amazonas N34-120, Quito', 1) RETURNING id`,
    [tenantId],
  );
  await db.query(`INSERT INTO billing.sequences (emission_point_id, doc_type, last_value) VALUES ($1, '01', $2), ($1, '04', 0)`, [
    rows[0].id,
    lastValue,
  ]);
  return rows[0].id;
}

export const RETURN_PERMISSIONS = ['returns.read', 'returns.approve', 'returns.inspect'];
export const REFUND_PERMISSIONS = ['payments.read', 'payments.refund.approve', 'payments.refund.complete'];

/** Otro usuario staff del tenant (segunda aprobación de un reembolso, separación de funciones). */
export async function createStaff(db: Queryable, tenantId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO iam.users (tenant_id, user_type, email) VALUES ($1, 'staff', $2) RETURNING id`,
    [tenantId, `staff+${randomUUID().slice(0, 8)}@example.test`],
  );
  return rows[0].id;
}
