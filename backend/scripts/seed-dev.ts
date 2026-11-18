/**
 * Datos mínimos para probar Inventario y Pedidos a mano (no usar en producción):
 * tenant "demo", un usuario de bodega, un cliente, un producto con 3 variantes, una bodega
 * en Quito, dos pedidos (tarjeta y contra entrega), promociones de ejemplo (envío gratis desde
 * $50 automática, cupón BIENVENIDA10 al 10 % no combinable y cupón 2X1CAMISETAS combinable) y
 * Catálogo del storefront: marcas, colores, tallas, guías de tallas y 50 productos con fotos, costo y stock
 * (scripts/seed-catalog.ts), y Logística: 3 zonas reales de Quito con sus franjas, y el courier simulado con su tarifario
 * (scripts/seed-logistics.ts), y Facturación: el punto de emisión 001-001 (ambiente de pruebas)
 * con su secuencial de facturas, e IAM: un usuario por rol (scripts/seed-iam.ts) con contraseña de desarrollo.
 * Es idempotente: si ya existe, solo vuelve a imprimir los ids.
 *
 *   npm run seed:dev
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { AppModule } from '../apps/api/app.module';
// SlotService es interno de Logística: un script de desarrollo puede usarlo (como los tests).
import { SlotService } from '../libs/modules/logistics/application/slot.service';
import { OrdersApi } from '../libs/modules/orders';
import { seedCatalog } from './seed-catalog';
import { DEV_ADMIN_TOTP_SECRET, DEV_PASSWORD, DEV_USERS, devAdminOtpauthUri, seedIam } from './seed-iam';
import { QUITO_ZONES, seedLogistics } from './seed-logistics';

export interface SeedDevOptions {
  /** Id fijo del tenant demo (STORE_TENANT_ID del seed de demo); sin él, lo genera la base. */
  tenantId?: string;
}

export type SeedDevResult = Awaited<ReturnType<typeof seedDev>>;

/** Todo lo de arriba; devuelve los ids que imprime `npm run seed:dev` (y reutiliza el seed de demo). */
export async function seedDev(options: SeedDevOptions = {}) {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    const tenant = await db.query<{ id: string }>(
      `INSERT INTO iam.tenants (id, slug, name) VALUES (COALESCE($1::uuid, gen_random_uuid()), 'demo', 'Moda Demo')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [options.tenantId ?? null],
    );
    const tenantId = tenant.rows[0].id;

    const user = await db.query<{ id: string }>(
      `INSERT INTO iam.users (tenant_id, user_type, email, first_name)
       VALUES ($1, 'staff', 'bodega@demo.test', 'Bodega')
       ON CONFLICT (tenant_id, email) DO UPDATE SET first_name = EXCLUDED.first_name RETURNING id`,
      [tenantId],
    );

    const category = await db.query<{ id: string }>(
      `INSERT INTO catalog.categories (tenant_id, name, slug, path) VALUES ($1, 'Camisetas', 'camisetas', 'unisex/camisetas')
       ON CONFLICT (tenant_id, path) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [tenantId],
    );
    const product = await db.query<{ id: string }>(
      `INSERT INTO catalog.products (tenant_id, category_id, name, slug, gender, base_price, cost, status)
       VALUES ($1, $2, 'Camiseta básica algodón', 'camiseta-basica', 'unisex', 14.90, 6.70, 'active')
       ON CONFLICT (tenant_id, slug) DO UPDATE SET name = EXCLUDED.name, cost = EXCLUDED.cost RETURNING id`,
      [tenantId, category.rows[0].id],
    );
    const variantIds: string[] = [];
    for (const size of ['S', 'M', 'L']) {
      const v = await db.query<{ id: string }>(
        `INSERT INTO catalog.product_variants (product_id, sku) VALUES ($1, $2)
         ON CONFLICT (sku) DO UPDATE SET sku = EXCLUDED.sku RETURNING id`,
        [product.rows[0].id, `DEMO-CAM-${size}`],
      );
      variantIds.push(v.rows[0].id);
    }

    const warehouse = await db.query<{ id: string }>(
      `INSERT INTO inventory.warehouses (tenant_id, code, name, type, address, location, city)
       VALUES ($1, 'UIO-01', 'Bodega Quito Norte', 'warehouse',
               '{"mainStreet":"Av. Amazonas","secondaryStreet":"Av. de la Prensa","province":"Pichincha"}'::jsonb,
               ST_SetSRID(ST_MakePoint(-78.4850, -0.1500), 4326)::geography, 'Quito')
       ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address RETURNING id`,
      [tenantId],
    );
    const customer = await db.query<{ id: string }>(
      `INSERT INTO iam.users (tenant_id, user_type, email, first_name, last_name)
       VALUES ($1, 'customer', 'cliente@demo.test', 'María', 'Loor')
       ON CONFLICT (tenant_id, email) DO UPDATE SET first_name = EXCLUDED.first_name RETURNING id`,
      [tenantId],
    );
    // Motorizado de demo (Quito Norte) para calificaciones y liquidaciones: tope de efectivo $200.
    const riderUser = await db.query<{ id: string }>(
      `INSERT INTO iam.users (tenant_id, user_type, email, first_name, last_name)
       VALUES ($1, 'rider', 'moto@demo.test', 'Carlos', 'Andrade')
       ON CONFLICT (tenant_id, email) DO UPDATE SET first_name = EXCLUDED.first_name RETURNING id`,
      [tenantId],
    );
    const catalog = await seedCatalog(db, tenantId, warehouse.rows[0].id);
    await seedPromotions(db, tenantId);
    await seedLoyaltyTiers(db, tenantId);
    const emissionPointId = await seedBilling(db, tenantId);
    const logistics = await seedLogistics(db, tenantId, warehouse.rows[0].id);
    const rider = await db.query<{ id: string }>(
      `INSERT INTO logistics.riders (user_id, tenant_id, vehicle_type, plate, home_zone_id, commission_scheme, cod_limit)
       VALUES ($1, $2, 'motorcycle', 'PBA-1234', $3,
               '{"per_delivery":2.50,"per_km":0.30,"bonus_tiers":[{"min_deliveries":40,"amount":10},{"min_deliveries":80,"amount":25}]}', 200)
       ON CONFLICT (user_id) DO UPDATE SET home_zone_id = EXCLUDED.home_zone_id RETURNING id`,
      [riderUser.rows[0].id, tenantId, logistics.zones.norte],
    );
    await db.query('COMMIT');

    const orderIds = await seedOrders(tenantId, customer.rows[0].id, product.rows[0].id, variantIds, warehouse.rows[0].id);
    const slots = await generateSlots(tenantId, [logistics.zones.norte, logistics.zones.centro]);
    const iamApp = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    const roleUsers = await seedIam(iamApp, tenantId);
    const adminOtpauth = devAdminOtpauthUri(iamApp);
    await iamApp.close();

    return {
      tenantId,
      userId: user.rows[0].id,
      customerId: customer.rows[0].id,
      riderId: rider.rows[0].id,
      riderUserId: riderUser.rows[0].id,
      warehouseId: warehouse.rows[0].id,
      variantIds,
      catalog,
      orderIds,
      zones: QUITO_ZONES.map((z) => ({
        id: logistics.zones[z.key],
        name: z.name,
        deliveryMode: z.deliveryMode,
        samplePoint: z.samplePoint,
      })),
      slotsCreated: slots,
      emissionPointId,
      courierServices: logistics.services,
      // SOLO desarrollo: un usuario por rol (POST /v1/auth/login con X-Tenant-Id = tenantId).
      credentials: DEV_USERS.map((u) => ({ role: u.role, email: u.email, password: DEV_PASSWORD, userId: roleUsers[u.role] })),
      adminTotp: { secret: DEV_ADMIN_TOTP_SECRET, otpauthUrl: adminOtpauth },
      logisticsZones: logistics.zones,
    };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

/**
 * Punto de emisión de la tienda en línea (SRI_ESTABLECIMIENTO-SRI_PUNTO_EMISION, 001-001 por
 * defecto) en ambiente de pruebas, con los secuenciales de facturas (01) y notas de crédito (04) en 0
 * si no existían.
 */
async function seedBilling(db: Client, tenantId: string): Promise<string> {
  const point = await db.query<{ id: string }>(
    `INSERT INTO billing.emission_points (tenant_id, establishment, emission_point, address, environment)
     VALUES ($1, $2, $3, 'Tienda en línea - Av. Amazonas N34-120 y Av. de la Prensa, Quito', 1)
     ON CONFLICT (tenant_id, establishment, emission_point) DO UPDATE SET active = true RETURNING id`,
    [tenantId, process.env.SRI_ESTABLECIMIENTO || '001', process.env.SRI_PUNTO_EMISION || '001'],
  );
  await db.query(
    `INSERT INTO billing.sequences (emission_point_id, doc_type, last_value) VALUES ($1, '01', 0), ($1, '04', 0)
     ON CONFLICT (emission_point_id, doc_type) DO NOTHING`,
    [point.rows[0].id],
  );
  return point.rows[0].id;
}

/** Promociones con ids fijos (ON CONFLICT DO NOTHING): volver a correr el seed no las duplica. */
async function seedPromotions(db: Client, tenantId: string): Promise<void> {
  const promos: [string, string, string, object, object, boolean, boolean][] = [
    ['5eed0000-0000-4000-8000-0000000000a1', 'Envío gratis desde $50', 'free_shipping', { minSubtotal: '50.00' }, {}, false, true],
    ['5eed0000-0000-4000-8000-0000000000a2', 'Bienvenida 10 %', 'percent', {}, { percent: 10 }, true, false],
    ['5eed0000-0000-4000-8000-0000000000a3', '2x1 en camisetas', 'buy_x_get_y', { categoryPaths: ['unisex/camisetas'] }, { buyQuantity: 1, getQuantity: 1, percentOff: 100 }, true, true],
  ];
  for (const [id, name, type, conditions, benefit, requiresCoupon, stackable] of promos) {
    await db.query(
      `INSERT INTO sales.promotions (id, tenant_id, name, type, conditions, benefit, requires_coupon, stackable, starts_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, '2026-01-01T00:00:00Z')
       ON CONFLICT (id) DO NOTHING`,
      [id, tenantId, name, type, JSON.stringify(conditions), JSON.stringify(benefit), requiresCoupon, stackable],
    );
  }
  await db.query(
    `INSERT INTO sales.coupons (promotion_id, tenant_id, code, max_uses, max_uses_per_customer)
     VALUES ('5eed0000-0000-4000-8000-0000000000a2', $1, 'BIENVENIDA10', 1000, 1),
            ('5eed0000-0000-4000-8000-0000000000a3', $1, '2X1CAMISETAS', NULL, 3)
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    [tenantId],
  );
}

/** Niveles del programa de puntos: Bronce ×1 desde 0, Plata ×1,25 desde 1000 y Oro ×1,5 desde 3000. */
async function seedLoyaltyTiers(db: Client, tenantId: string): Promise<void> {
  await db.query(
    `INSERT INTO crm.loyalty_tiers (tenant_id, name, min_points, multiplier, benefits)
     VALUES ($1, 'Bronce', 0, 1.00, '{}'),
            ($1, 'Plata', 1000, 1.25, '{"envioGratisDesde":"40.00"}'),
            ($1, 'Oro', 3000, 1.50, '{"envioGratis":true,"accesoAnticipado":true}')
     ON CONFLICT (tenant_id, min_points) DO NOTHING`,
    [tenantId],
  );
}

/**
 * Dos pedidos de ejemplo creados con OrdersApi (el mismo camino que usará Checkout), con ids
 * fijos: placeOrder es idempotente por id, así que volver a correr el seed no los duplica.
 */
async function seedOrders(
  tenantId: string,
  customerId: string,
  productId: string,
  variantIds: string[],
  warehouseId: string,
): Promise<{ card: string; cod: string }> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const orders = app.get(OrdersApi);
    const base = {
      tenantId,
      userId: customerId,
      customer: { name: 'María Loor', email: 'cliente@demo.test', phone: '0991234567' },
      billing: { idType: '05', idNumber: '1710034065', name: 'María Loor' },
      fulfillmentType: 'rider' as const,
      shippingAddress: { mainStreet: 'Av. Amazonas', number: 'N34-120', city: 'Quito' },
      shippingLocation: { lat: -0.1807, lng: -78.4678 },
      shippingCity: 'Quito',
      sourceWarehouseId: warehouseId,
      shippingTotal: '3.50',
    };
    const line = (i: number, size: string, quantity: number) => ({
      variantId: variantIds[i],
      productId,
      sku: `DEMO-CAM-${size}`,
      productName: 'Camiseta básica algodón',
      categoryPath: 'unisex/camisetas',
      colorName: 'Blanco',
      sizeCode: size,
      quantity,
      unitPrice: '14.90',
      taxCode: '4',
      taxRate: '15.00',
      warehouseId,
    });
    const card = await orders.placeOrder({
      ...base,
      id: '5eed0000-0000-4000-8000-000000000001',
      paymentMethod: 'card',
      items: [line(0, 'S', 1), line(1, 'M', 2)],
    });
    const cod = await orders.placeOrder({
      ...base,
      id: '5eed0000-0000-4000-8000-000000000002',
      paymentMethod: 'cod',
      items: [line(2, 'L', 1)],
    });
    return { card: card.id, cod: cod.id };
  } finally {
    await app.close();
  }
}

/** Franjas de los próximos días desde las plantillas (lo mismo que hace el job del worker). */
export async function generateSlots(tenantId: string, zoneIds: string[]): Promise<number> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const slots = app.get(SlotService);
    let created = 0;
    for (const zoneId of zoneIds) created += (await slots.generateForZone(tenantId, zoneId)).created;
    return created;
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  console.log(JSON.stringify(await seedDev(), null, 2));
}

// Como script (npm run seed:dev); importado por seed-demo.ts no se ejecuta.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
