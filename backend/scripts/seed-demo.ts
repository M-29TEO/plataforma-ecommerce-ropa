/**
 * Seed de la demostración (docs/DEMO.md). Parte de `seed:dev` (50 productos con fotos y costo,
 * un usuario por rol, zonas, promociones, punto de emisión del SRI) y agrega lo que hace falta para
 * que la tienda se vea con 3 meses de operación:
 *  - 2 zonas más de Quito (Quito Sur y Valle de los Chillos) y franjas en todas las zonas propias.
 *  - 6 motorizados con zona base (el de seed:dev y 5 más; contraseña de desarrollo).
 *  - 120 clientes registrados con su dirección por barrio (y compras de invitados).
 *  - ~800 pedidos de los últimos 90 días (hasta ayer): pagos, envíos entregados por motorizado,
 *    courier o retiro en tienda, calificaciones, devoluciones reembolsadas, cancelaciones, carritos
 *    abandonados y liquidaciones semanales de los motorizados. Al final refresca las vistas de Reportes.
 *
 * Aleatorio con semilla fija (mismos datos en cada corrida, con fechas relativas a hoy). Idempotente:
 * si el historial ya está, no lo duplica (vuelve a correr seed:dev y refresca las vistas).
 *
 * El historial va por SQL directo, como un import de datos: así puede llevar fechas pasadas, que los
 * casos de uso fijan en "ahora". Lo vivo de la demo (compra, pago, despacho, factura, devolución)
 * pasa por la API. Los pedidos históricos no tienen factura electrónica: solo los de la demo.
 *
 *   npm run seed:demo                   (fuera de Docker; con STORE_TENANT_ID fija el id del tenant)
 *   node dist/scripts/seed-demo.js      (servicio "seed" de docker-compose.yml, ver .env.demo.example)
 */
import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { AppModule } from '../apps/api/app.module';
// Internos (como seed-iam y los tests): un script de datos de demo puede usarlos.
import { PasswordHasher } from '../libs/modules/iam/application/ports';
import { RoleService } from '../libs/modules/iam/application/role.service';
import { SettlementService } from '../libs/modules/logistics/application/settlement.service';
import { SlotService } from '../libs/modules/logistics/application/slot.service';
import { Database } from '../libs/shared-kernel';
import { seedDev } from './seed-dev';
import { DEV_PASSWORD } from './seed-iam';
import { QUITO_ZONES, SeedZone, upsertZone } from './seed-logistics';

// ------------------------------------------------------------------ datos fijos

type ZoneKey = 'norte' | 'centro' | 'cumbaya' | 'sur' | 'chillos';

const MON_SAT = [1, 2, 3, 4, 5, 6];

/** Zonas que solo usa la demo (las 3 de seed-logistics las cargan también los tests). Polígonos aproximados sobre OSM. */
const DEMO_ZONES: (Omit<SeedZone, 'key' | 'samplePoint'> & { key: ZoneKey })[] = [
  {
    key: 'sur',
    name: 'Quito Sur · La Magdalena, Solanda y Quitumbe',
    city: 'Quito',
    deliveryMode: 'rider',
    priority: 40,
    baseFee: '3.00',
    feePerKm: '0.30',
    feePerExtraKg: '0.50',
    maxWeightKg: 15,
    freeShippingThreshold: null,
    sameDayCutoff: '13:00',
    // De la Av. Rodrigo de Chávez (norte) a Quitumbe (sur), entre la Av. Mariscal Sucre y la Maldonado.
    area: {
      type: 'Polygon',
      coordinates: [
        [
          [-78.535, -0.235],
          [-78.505, -0.24],
          [-78.5, -0.275],
          [-78.525, -0.31],
          [-78.56, -0.3],
          [-78.565, -0.265],
          [-78.535, -0.235],
        ],
      ],
    },
    templates: MON_SAT.flatMap((weekday) => [
      { weekday, startTime: '10:00', endTime: '13:00', capacity: 6, surcharge: '0.00' },
      { weekday, startTime: '14:00', endTime: '17:00', capacity: 6, surcharge: '0.00' },
      { weekday, startTime: '17:00', endTime: '20:00', capacity: 4, surcharge: '0.50' },
    ]),
  },
  {
    key: 'chillos',
    name: 'Valle de los Chillos · Conocoto, San Rafael y Sangolquí',
    city: 'Sangolquí',
    deliveryMode: 'rider',
    priority: 50,
    baseFee: '3.50',
    feePerKm: '0.25',
    feePerExtraKg: '0.50',
    maxWeightKg: 15,
    freeShippingThreshold: null,
    sameDayCutoff: '12:00',
    area: {
      type: 'Polygon',
      coordinates: [
        [
          [-78.475, -0.28],
          [-78.44, -0.285],
          [-78.425, -0.31],
          [-78.435, -0.345],
          [-78.47, -0.34],
          [-78.485, -0.305],
          [-78.475, -0.28],
        ],
      ],
    },
    templates: MON_SAT.flatMap((weekday) => [
      { weekday, startTime: '11:00', endTime: '14:00', capacity: 4, surcharge: '0.00' },
      { weekday, startTime: '15:00', endTime: '19:00', capacity: 4, surcharge: '0.00' },
    ]),
  },
];

interface Neighborhood {
  name: string;
  zone: ZoneKey;
  city: string;
  lat: number;
  lng: number;
  streets: [main: string, cross: string];
}

/** Barrios con un punto dentro de su zona (se valida al arrancar) y dos calles reales cercanas. */
const NEIGHBORHOODS: Neighborhood[] = [
  { name: 'La Carolina', zone: 'norte', city: 'Quito', lat: -0.184, lng: -78.483, streets: ['Av. de los Shyris', 'Av. Naciones Unidas'] },
  { name: 'Iñaquito', zone: 'norte', city: 'Quito', lat: -0.177, lng: -78.488, streets: ['Av. Amazonas', 'Av. Naciones Unidas'] },
  { name: 'El Batán', zone: 'norte', city: 'Quito', lat: -0.17, lng: -78.476, streets: ['Av. 6 de Diciembre', 'Calle Gaspar de Villarroel'] },
  { name: 'Benalcázar', zone: 'norte', city: 'Quito', lat: -0.188, lng: -78.478, streets: ['Av. Eloy Alfaro', 'Calle Portugal'] },
  { name: 'Quito Tennis', zone: 'norte', city: 'Quito', lat: -0.162, lng: -78.493, streets: ['Av. Brasil', 'Calle Zamora'] },
  { name: 'Jipijapa', zone: 'norte', city: 'Quito', lat: -0.155, lng: -78.48, streets: ['Av. Río Coca', 'Av. de los Shyris'] },
  { name: 'El Labrador', zone: 'norte', city: 'Quito', lat: -0.142, lng: -78.488, streets: ['Av. Amazonas', 'Calle Río Palora'] },
  { name: 'San Marcos', zone: 'centro', city: 'Quito', lat: -0.221, lng: -78.509, streets: ['Calle Junín', 'Calle Montúfar'] },
  { name: 'La Ronda', zone: 'centro', city: 'Quito', lat: -0.2245, lng: -78.5135, streets: ['Calle Morales', 'Av. 24 de Mayo'] },
  { name: 'San Blas', zone: 'centro', city: 'Quito', lat: -0.215, lng: -78.5085, streets: ['Calle Caldas', 'Calle Guayaquil'] },
  { name: 'La Tola', zone: 'centro', city: 'Quito', lat: -0.22, lng: -78.505, streets: ['Calle Valparaíso', 'Calle Los Ríos'] },
  { name: 'La Magdalena', zone: 'sur', city: 'Quito', lat: -0.242, lng: -78.523, streets: ['Av. Mariscal Sucre', 'Calle Michelena'] },
  { name: 'El Recreo', zone: 'sur', city: 'Quito', lat: -0.252, lng: -78.522, streets: ['Av. Pedro Vicente Maldonado', 'Calle Gatazo'] },
  { name: 'Solanda', zone: 'sur', city: 'Quito', lat: -0.267, lng: -78.537, streets: ['Av. Ajaví', 'Calle José María Alemán'] },
  { name: 'Chillogallo', zone: 'sur', city: 'Quito', lat: -0.28, lng: -78.556, streets: ['Av. Mariscal Sucre', 'Calle Carlos Freile'] },
  { name: 'Quitumbe', zone: 'sur', city: 'Quito', lat: -0.295, lng: -78.544, streets: ['Av. Quitumbe Ñan', 'Av. Rumichaca'] },
  { name: 'Conocoto', zone: 'chillos', city: 'Conocoto', lat: -0.292, lng: -78.472, streets: ['Av. Simón Bolívar', 'Calle García Moreno'] },
  { name: 'San Rafael', zone: 'chillos', city: 'Sangolquí', lat: -0.3, lng: -78.457, streets: ['Av. General Enríquez', 'Av. San Luis'] },
  { name: 'Capelo', zone: 'chillos', city: 'Sangolquí', lat: -0.315, lng: -78.45, streets: ['Av. El Progreso', 'Calle Ilaló'] },
  { name: 'Sangolquí centro', zone: 'chillos', city: 'Sangolquí', lat: -0.329, lng: -78.448, streets: ['Calle Montúfar', 'Calle Riofrío'] },
  { name: 'Cumbayá', zone: 'cumbaya', city: 'Cumbayá', lat: -0.2025, lng: -78.429, streets: ['Av. Interoceánica', 'Calle Francisco de Orellana'] },
  { name: 'Miravalle', zone: 'cumbaya', city: 'Cumbayá', lat: -0.196, lng: -78.435, streets: ['Calle Pampite', 'Calle Chimborazo'] },
  { name: 'Tumbaco', zone: 'cumbaya', city: 'Tumbaco', lat: -0.212, lng: -78.4, streets: ['Av. Interoceánica', 'Calle Juan Montalvo'] },
];

const ZONE_WEIGHTS: [ZoneKey, number][] = [
  ['norte', 42],
  ['centro', 8],
  ['sur', 22],
  ['chillos', 13],
  ['cumbaya', 15],
];

/** Tarifa de envío con motorizado por zona (la misma que cobra Logística): base + por km. */
const RIDER_FEES: Partial<Record<ZoneKey, [base: number, perKm: number]>> = {
  norte: [250, 35],
  centro: [200, 30],
  sur: [300, 30],
  chillos: [350, 25],
};

interface DemoRider {
  email: string;
  firstName: string;
  lastName: string;
  plate: string;
  zone: ZoneKey;
  /** Probabilidad de entregar dentro de la franja y calificación media: cada uno rinde distinto en los reportes. */
  onTime: number;
  rating: number;
}

/** El primero es el motorizado de seed:dev (moto@demo.test), el de la app en el guion. */
const DEMO_RIDERS: DemoRider[] = [
  { email: 'moto@demo.test', firstName: 'Carlos', lastName: 'Andrade', plate: 'PBA-1234', zone: 'norte', onTime: 0.94, rating: 4.7 },
  { email: 'andres.tapia@demo.test', firstName: 'Andrés', lastName: 'Tapia', plate: 'PBC-2210', zone: 'norte', onTime: 0.9, rating: 4.5 },
  { email: 'gabriela.chicaiza@demo.test', firstName: 'Gabriela', lastName: 'Chicaiza', plate: 'PCB-3318', zone: 'centro', onTime: 0.96, rating: 4.8 },
  { email: 'luis.quishpe@demo.test', firstName: 'Luis', lastName: 'Quishpe', plate: 'PCD-4471', zone: 'sur', onTime: 0.84, rating: 4.2 },
  { email: 'wilson.caiza@demo.test', firstName: 'Wilson', lastName: 'Caiza', plate: 'PCE-9035', zone: 'sur', onTime: 0.88, rating: 4.4 },
  { email: 'fernanda.ortiz@demo.test', firstName: 'Fernanda', lastName: 'Ortiz', plate: 'PBF-6620', zone: 'chillos', onTime: 0.91, rating: 4.6 },
];

const FIRST_F = ['María José', 'Daniela', 'Gabriela', 'Valentina', 'Camila', 'Andrea', 'Paola', 'Sofía', 'Carolina', 'Verónica', 'Fernanda', 'Lorena', 'Mishell', 'Estefanía', 'Karla'];
const FIRST_M = ['Juan Carlos', 'Santiago', 'Diego', 'Sebastián', 'Andrés', 'Mateo', 'Luis', 'José', 'Esteban', 'Christian', 'David', 'Fabián', 'Ricardo', 'Patricio', 'Bryan'];
const LAST = [
  'Pérez', 'Andrade', 'Vásquez', 'Guerrero', 'Mora', 'Salazar', 'Cevallos', 'Morales', 'Jaramillo', 'Benítez',
  'Torres', 'Zambrano', 'Espinoza', 'Chávez', 'Herrera', 'Paredes', 'Villacís', 'Toapanta', 'Quishpe', 'Cando',
  'Yépez', 'Proaño', 'Ortega', 'Viteri', 'Larrea', 'Endara', 'Chiriboga', 'Naranjo', 'Montalvo', 'Ruiz',
];

const CUSTOMERS = 120;
const HISTORY_DAYS = 90;
const REASONS: [string, number][] = [
  ['size_small', 30],
  ['size_large', 25],
  ['changed_mind', 20],
  ['defect', 10],
  ['not_as_described', 10],
  ['wrong_item', 5],
];
const GOOD_TAGS = ['puntual', 'amable', 'cuidadoso', 'buena_comunicacion'];
const BAD_TAGS = ['impuntual', 'no_siguio_indicaciones', 'descortes'];
const GOOD_COMMENTS = ['Llegó antes de lo esperado, muy amable.', 'Todo perfecto, gracias.', 'Excelente servicio, el paquete llegó impecable.', 'Muy puntual.'];
const BAD_COMMENTS = ['Llegó tarde y no avisó.', 'Tuve que llamarlo varias veces para encontrar la dirección.'];

// ------------------------------------------------------------------ azar con semilla

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261012);
const chance = (p: number) => rand() < p;
const between = (a: number, b: number) => a + rand() * (b - a);
const int = (a: number, b: number) => Math.floor(between(a, b + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
function weighted<T>(entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of entries) if ((r -= w) < 0) return v;
  return entries[entries.length - 1][0];
}
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
function uuid(): string {
  const h = hex(32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[Math.floor(rand() * 4)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Como los tokens de seguimiento reales (18 bytes en base64url). */
const trackingToken = () => Buffer.from(hex(36), 'hex').toString('base64url');

// ------------------------------------------------------------------ utilidades

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** America/Guayaquil es UTC-5 todo el año. */
const LOCAL_OFFSET = 5 * HOUR;
const money = (cents: number) => (cents / 100).toFixed(2);
const point = (lat: number, lng: number) => `SRID=4326;POINT(${lng} ${lat})`;
const ascii = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]+/g, '');

function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function inPolygon(lat: number, lng: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Cédula ecuatoriana válida (Pichincha, dígito verificador módulo 10). */
function cedula(): string {
  const digits = [1, 7, int(0, 5), ...Array.from({ length: 6 }, () => int(0, 9))];
  const sum = digits.reduce((s, d, i) => {
    const v = d * (i % 2 === 0 ? 2 : 1);
    return s + (v > 9 ? v - 9 : v);
  }, 0);
  return [...digits, (10 - (sum % 10)) % 10].join('');
}

/** INSERT de muchas filas por lotes (parámetros sin tipo: PostgreSQL toma el de cada columna). */
async function insertMany(db: Client, table: string, columns: string[], rows: unknown[][], returning = ''): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const chunk = Math.max(1, Math.floor(30_000 / columns.length));
  for (let i = 0; i < rows.length; i += chunk) {
    const params: unknown[] = [];
    const values = rows.slice(i, i + chunk).map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(', ')})`);
    const res = await db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}${returning ? ` RETURNING ${returning}` : ''}`, params);
    out.push(...res.rows);
  }
  return out;
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const fixedTenant = process.env.STORE_TENANT_ID?.trim() || undefined;
  const dev = await seedDev({ tenantId: fixedTenant });
  if (fixedTenant && dev.tenantId !== fixedTenant) {
    throw new Error(
      `La base ya tiene el tenant "demo" con id ${dev.tenantId}, distinto de STORE_TENANT_ID=${fixedTenant}. ` +
        'Pon ese id en STORE_TENANT_ID (.env) o parte de una base vacía (docker compose down -v).',
    );
  }
  const tenantId = dev.tenantId;
  for (const n of NEIGHBORHOODS) {
    const zone = [...QUITO_ZONES, ...DEMO_ZONES].find((z) => z.key === n.zone)!;
    if (!inPolygon(n.lat, n.lng, zone.area.coordinates[0])) throw new Error(`El barrio ${n.name} quedó fuera de su zona (${zone.name})`);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    // Zonas extra y franjas de los próximos días en todas las zonas con motorizado.
    const zones: Record<ZoneKey, string> = { ...(dev.logisticsZones as Record<'norte' | 'centro' | 'cumbaya', string>), sur: '', chillos: '' };
    for (const z of DEMO_ZONES) zones[z.key] = await upsertZone(db, tenantId, z, dev.warehouseId);
    const slots = app.get(SlotService);
    for (const key of ['norte', 'centro', 'sur', 'chillos'] as const) await slots.generateForZone(tenantId, zones[key]);

    const riders = await seedRiders(app, tenantId, zones);
    const customers = await seedCustomers(db, tenantId);

    const existing = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sales.orders WHERE tenant_id = $1 AND utm->>'seed' = 'demo'`, [tenantId]);
    let history: HistorySummary | null = null;
    if (existing.rows[0].n === 0) {
      await db.query('BEGIN');
      history = await seedHistory(db, tenantId, dev, zones, riders, customers);
      await db.query('COMMIT');
      await settleRiders(app, db, tenantId);
    }
    await refreshReports(db);

    console.log(
      JSON.stringify(
        {
          tenantId,
          storefront: 'http://localhost',
          backoffice: 'http://localhost/admin',
          products: dev.catalog.products + 1,
          zones: Object.keys(zones).length,
          riders: riders.length,
          customers: customers.length,
          history: history ?? `ya estaba (${existing.rows[0].n} pedidos históricos)`,
          // SOLO desarrollo y demo.
          password: DEV_PASSWORD,
          staff: dev.credentials.filter((c) => c.role !== 'customer' && c.role !== 'rider').map((c) => `${c.role}: ${c.email}`),
          riderLogins: DEMO_RIDERS.map((r) => r.email),
          adminTotpSecret: dev.adminTotp.secret,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await db.end();
    await app.close();
  }
}

// ------------------------------------------------------------------ motorizados y clientes

interface RiderRow extends DemoRider {
  riderId: string;
  userId: string;
  zoneId: string;
}

async function seedRiders(app: INestApplicationContext, tenantId: string, zones: Record<ZoneKey, string>): Promise<RiderRow[]> {
  const db = app.get(Database);
  const roles = app.get(RoleService);
  const passwordHash = await app.get(PasswordHasher).hash(DEV_PASSWORD);
  const out: RiderRow[] = [];
  await db.withTransaction(async (tx) => {
    for (const r of DEMO_RIDERS) {
      const user = await tx.query<{ id: string }>(
        `INSERT INTO iam.users (tenant_id, user_type, email, password_hash, first_name, last_name, phone, status, email_verified_at)
         VALUES ($1, 'rider', $2, $3, $4, $5, $6, 'active', now())
         ON CONFLICT (tenant_id, email) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name
         RETURNING id`,
        [tenantId, r.email, passwordHash, r.firstName, r.lastName, `09${String(80000000 + out.length * 1234567).slice(0, 8)}`],
      );
      await roles.grantInitialRole(tx, tenantId, user.rows[0].id, 'rider');
      const rider = await tx.query<{ id: string }>(
        `INSERT INTO logistics.riders (user_id, tenant_id, vehicle_type, plate, home_zone_id, cod_limit)
         VALUES ($1, $2, 'motorcycle', $3, $4, 200)
         ON CONFLICT (user_id) DO UPDATE SET plate = EXCLUDED.plate, home_zone_id = EXCLUDED.home_zone_id
         RETURNING id`,
        [user.rows[0].id, tenantId, r.plate, zones[r.zone]],
      );
      out.push({ ...r, riderId: rider.rows[0].id, userId: user.rows[0].id, zoneId: zones[r.zone] });
    }
  });
  return out;
}

interface CustomerRow {
  userId: string;
  name: string;
  email: string;
  phone: string;
  idNumber: string;
  hood: Neighborhood;
  address: Address;
  /** Cuántas veces más compra que el promedio (pocos clientes frecuentes, muchos ocasionales). */
  weight: number;
}

interface Address {
  mainStreet: string;
  secondaryStreet: string;
  number: string;
  neighborhood: string;
  city: string;
  province: string;
  reference: string;
  lat: number;
  lng: number;
}

function personName(): { first: string; last: string; gender: 'F' | 'M' } {
  const gender = chance(0.62) ? 'F' : 'M';
  return { first: pick(gender === 'F' ? FIRST_F : FIRST_M), last: `${pick(LAST)} ${pick(LAST)}`, gender };
}

function addressIn(hood: Neighborhood): Address {
  const zone = [...QUITO_ZONES, ...DEMO_ZONES].find((z) => z.key === hood.zone)!;
  let lat = hood.lat;
  let lng = hood.lng;
  // Alrededor del punto del barrio (~300 m), sin salirse de la zona.
  for (let i = 0; i < 10; i++) {
    const la = hood.lat + between(-0.003, 0.003);
    const ln = hood.lng + between(-0.003, 0.003);
    if (inPolygon(la, ln, zone.area.coordinates[0])) {
      lat = Math.round(la * 1e6) / 1e6;
      lng = Math.round(ln * 1e6) / 1e6;
      break;
    }
  }
  return {
    mainStreet: hood.streets[0],
    secondaryStreet: hood.streets[1],
    number: `${pick(['N', 'E', 'S', 'Oe'])}${int(10, 79)}-${int(10, 290)}`,
    neighborhood: hood.name,
    city: hood.city,
    province: 'Pichincha',
    reference: pick(['Casa esquinera', 'Edificio de vidrio, piso 3', 'Junto a la tienda de la esquina', 'Portón negro', 'Frente al parque', 'Conjunto residencial, casa 12']),
    lat,
    lng,
  };
}

async function seedCustomers(db: Client, tenantId: string): Promise<CustomerRow[]> {
  const out: CustomerRow[] = [];
  const zoneOf = (key: ZoneKey) => NEIGHBORHOODS.filter((n) => n.zone === key);
  for (let i = 0; i < CUSTOMERS; i++) {
    const p = personName();
    const email = `${ascii(p.first.split(' ')[0])}.${ascii(p.last.split(' ')[0])}${i + 1}@correo.test`;
    const phone = `09${int(60000000, 99999999)}`;
    const idNumber = cedula();
    const hood = pick(zoneOf(weighted(ZONE_WEIGHTS)));
    const address = addressIn(hood);
    const user = await db.query<{ id: string }>(
      `INSERT INTO iam.users (tenant_id, user_type, email, first_name, last_name, phone, id_type, id_number, status, email_verified_at, created_at)
       VALUES ($1, 'customer', $2, $3, $4, $5, '05', $6, 'active', now(), now() - interval '200 days')
       ON CONFLICT (tenant_id, email) DO UPDATE SET first_name = EXCLUDED.first_name RETURNING id`,
      [tenantId, email, p.first, p.last, phone, idNumber],
    );
    const userId = user.rows[0].id;
    await db.query(
      `INSERT INTO crm.addresses (tenant_id, user_id, label, recipient_name, recipient_phone, province, city, neighborhood, main_street,
                                  cross_street, house_number, reference, location, geocode_accuracy, is_default)
       SELECT $1, $2, 'Casa', $3, $4, 'Pichincha', $5, $6, $7, $8, $9, $10, $11, 'user_pin', true
        WHERE NOT EXISTS (SELECT 1 FROM crm.addresses WHERE user_id = $2)`,
      [tenantId, userId, `${p.first} ${p.last}`, phone, address.city, address.neighborhood, address.mainStreet, address.secondaryStreet, address.number, address.reference, point(address.lat, address.lng)],
    );
    await db.query(
      `INSERT INTO crm.customer_profiles (tenant_id, user_id, gender) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
      [tenantId, userId, p.gender === 'F' ? 'female' : 'male'],
    );
    out.push({ userId, name: `${p.first} ${p.last}`, email, phone, idNumber, hood, address, weight: weighted([[6, 1], [2.5, 3], [1, 6]] as const) });
  }
  return out;
}

// ------------------------------------------------------------------ historial

interface Variant {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  brand: string | null;
  category: string;
  color: string | null;
  size: string | null;
  price: number;
  cost: number | null;
  weightG: number;
}

interface HistorySummary {
  days: number;
  orders: number;
  delivered: number;
  cancelled: number;
  returns: number;
  abandonedCarts: number;
  ratings: number;
}

const SIZE_WEIGHTS: Record<string, number> = { XS: 8, S: 22, M: 32, L: 25, XL: 13, '28': 12, '30': 25, '32': 30, '34': 22, '36': 11, Única: 10 };
const BESTSELLERS = ['camiseta-basica-organica', 'jean-mom-tiro-alto', 'sudadera-capucha', 'vestido-midi-lino', 'pantalon-chino-hombre', 'chaqueta-mezclilla-mujer'];
const HOUR_WEIGHTS: [number, number][] = [
  [7, 1], [8, 2], [9, 3], [10, 4], [11, 5], [12, 7], [13, 7], [14, 5], [15, 4], [16, 4], [17, 5], [18, 6], [19, 8], [20, 9], [21, 8], [22, 5], [23, 2],
];
/** Franjas típicas con motorizado (hora local de inicio y fin). */
const SLOT_WINDOWS: [number, number][] = [
  [9, 12],
  [12, 15],
  [15, 18],
  [18, 20],
];

async function seedHistory(
  db: Client,
  tenantId: string,
  dev: Awaited<ReturnType<typeof seedDev>>,
  zones: Record<ZoneKey, string>,
  riders: RiderRow[],
  customers: CustomerRow[],
): Promise<HistorySummary> {
  const { rows: vrows } = await db.query<{
    id: string; product_id: string; sku: string; slug: string; name: string; brand: string | null; category: string;
    color: string | null; size: string | null; price: string; cost: string | null; weight_g: number;
  }>(
    `SELECT v.id, p.id AS product_id, v.sku, p.slug, p.name, b.name AS brand, c.path AS category, col.name AS color, s.code AS size,
            COALESCE(v.price, p.base_price) AS price, p.cost, v.weight_g
       FROM catalog.products p
       JOIN catalog.categories c ON c.id = p.category_id
       LEFT JOIN catalog.brands b ON b.id = p.brand_id
       JOIN catalog.product_variants v ON v.product_id = p.id AND v.status = 'active'
       LEFT JOIN catalog.colors col ON col.id = v.color_id
       LEFT JOIN catalog.sizes s ON s.id = v.size_id
      WHERE p.tenant_id = $1 AND p.status = 'active'
      ORDER BY p.slug, v.sku`,
    [tenantId],
  );
  const bySlug = new Map<string, Variant[]>();
  for (const r of vrows) {
    const v: Variant = {
      id: r.id, productId: r.product_id, sku: r.sku, productName: r.name, brand: r.brand, category: r.category, color: r.color, size: r.size,
      price: Math.round(Number(r.price) * 100), cost: r.cost === null ? null : Math.round(Number(r.cost) * 100), weightG: r.weight_g,
    };
    bySlug.set(r.slug, [...(bySlug.get(r.slug) ?? []), v]);
  }
  // Popularidad: unos pocos productos venden mucho (curva tipo Zipf sobre un orden con semilla).
  const slugs = [...bySlug.keys()].sort(() => rand() - 0.5);
  const productWeights = slugs.map((slug, i) => [slug, (BESTSELLERS.includes(slug) ? 3 : 1) / Math.pow(i + 1, 0.55)] as const);
  const pickVariant = (): Variant => {
    const variants = bySlug.get(weighted(productWeights))!;
    const color = pick([...new Set(variants.map((v) => v.color))]);
    return weighted(variants.filter((v) => v.color === color).map((v) => [v, SIZE_WEIGHTS[v.size ?? ''] ?? 10] as const));
  };

  const warehouse = { lat: -0.15, lng: -78.485 };
  const { rows: services } = await db.query<{ id: string; code: string; sla_hours: number }>(
    `SELECT cs.id, cs.code, cs.sla_hours FROM logistics.courier_services cs JOIN logistics.couriers c ON c.id = cs.courier_id
      WHERE c.tenant_id = $1 AND c.code = 'simulador'`,
    [tenantId],
  );
  const service = (code: string) => services.find((s) => s.code === code)!;
  const roleUser = (role: string) => dev.credentials.find((c) => c.role === role)!.userId;
  const seller = roleUser('seller');
  const support = roleUser('support');
  const manager = roleUser('manager');
  const warehouseStaff = roleUser('warehouse');
  const ridersByZone = (key: ZoneKey) => riders.filter((r) => r.zone === key);

  const now = Date.now();
  const todayLocal = Math.floor((now - LOCAL_OFFSET) / DAY) * DAY + LOCAL_OFFSET; // 00:00 de hoy en Guayaquil (UTC)
  const orders: unknown[][] = [];
  const items: unknown[][] = [];
  const history: unknown[][] = [];
  const payments: unknown[][] = [];
  const shipments: unknown[][] = [];
  const events: unknown[][] = [];
  const ratings: unknown[][] = [];
  const carts: unknown[][] = [];
  const cartItems: unknown[][] = [];
  const returns: { orderId: string; row: unknown[] }[] = [];
  const returnItems: unknown[][] = [];
  const refunds: unknown[][] = [];
  const firstOrderOf = new Map<string, number>();
  const profile = new Map<string, { count: number; value: number; last: number }>();
  let delivered = 0;
  let cancelled = 0;
  let abandoned = 0;

  for (let d = HISTORY_DAYS; d >= 1; d--) {
    const dayStart = todayLocal - d * DAY;
    const date = new Date(dayStart - LOCAL_OFFSET + 12 * HOUR); // mediodía local, para el día de la semana y del mes
    const weekday = new Date(dayStart).getUTCDay();
    const dom = date.getUTCDate();
    // Crecimiento de 5 a 10 pedidos diarios, fines de semana, quincenas y la "Semana de la moda" hace un mes.
    let expected = 5 + (5 * (HISTORY_DAYS - d)) / HISTORY_DAYS;
    if (weekday === 6 || weekday === 0) expected *= 1.35;
    if (weekday === 5) expected *= 1.15;
    if ([1, 14, 15, 16, 29, 30, 31].includes(dom)) expected *= 1.4;
    if (d >= 30 && d <= 33) expected *= 2.1;
    const n = Math.max(1, Math.round(expected * between(0.75, 1.25)));
    const times = Array.from({ length: n }, () => dayStart + weighted(HOUR_WEIGHTS) * HOUR + int(0, 59) * MIN + int(0, 59) * 1000).sort((a, b) => a - b);

    for (const placedAt of times) {
      const registered = chance(0.7);
      const customer = registered ? weighted(customers.map((c) => [c, c.weight] as const)) : null;
      const guest = customer ? null : personName();
      const name = customer?.name ?? `${guest!.first} ${guest!.last}`;
      const email = customer?.email ?? `${ascii(guest!.first.split(' ')[0])}.${ascii(guest!.last.split(' ')[0])}${int(1, 999)}@correo.test`;
      const phone = customer?.phone ?? `09${int(60000000, 99999999)}`;
      const guestZone = weighted(ZONE_WEIGHTS);
      const address = customer?.address ?? addressIn(pick(NEIGHBORHOODS.filter((h) => h.zone === guestZone)));
      const hood = NEIGHBORHOODS.find((h) => h.name === address.neighborhood)!;
      const zoneKey = hood.zone;
      const fulfillment = zoneKey === 'cumbaya' ? 'courier' : chance(0.1) ? 'pickup' : 'rider';
      const channel = weighted([['web', 78], ['app', 7], ['whatsapp', 5], ['backoffice', 10]] as const);
      const method =
        fulfillment === 'rider'
          ? weighted([['card', 50], ['transfer', 13], ['cod', 25], ['deuna', 8], ['pichincha', 4]] as const)
          : weighted([['card', 65], ['transfer', 20], ['deuna', 10], ['pichincha', 5]] as const);

      // Líneas: 1 a 4 prendas distintas.
      const lineCount = weighted([[1, 50], [2, 30], [3, 15], [4, 5]] as const);
      const lines = new Map<string, { v: Variant; qty: number }>();
      while (lines.size < lineCount) {
        const v = pickVariant();
        if (!lines.has(v.id)) lines.set(v.id, { v, qty: chance(0.12) ? 2 : 1 });
      }
      const firstOrder = customer && !firstOrderOf.has(customer.userId);
      const coupon = firstOrder && chance(0.35);
      const orderId = uuid();
      let subtotal = 0;
      let discountTotal = 0;
      let taxTotal = 0;
      let weightG = 0;
      const itemRows: { id: string; v: Variant; qty: number; discount: number; tax: number; lineTotal: number }[] = [];
      for (const { v, qty } of lines.values()) {
        const base = v.price * qty;
        const discount = coupon ? Math.round(base * 0.1) : 0;
        const tax = Math.round(((base - discount) * 15) / 100);
        subtotal += base;
        discountTotal += discount;
        taxTotal += tax;
        weightG += v.weightG * qty;
        itemRows.push({ id: uuid(), v, qty, discount, tax, lineTotal: base - discount + tax });
      }
      const km = distanceKm(warehouse, address) * 1.35;
      const express = fulfillment === 'courier' && chance(0.25);
      let shipping = 0;
      if (fulfillment === 'rider') {
        const [fee, perKm] = RIDER_FEES[zoneKey]!;
        shipping = subtotal - discountTotal >= 5000 ? 0 : Math.round((fee + perKm * km) / 5) * 5;
      } else if (fulfillment === 'courier') {
        shipping = subtotal - discountTotal >= 5000 ? 0 : express ? 650 : 450;
      }
      const total = subtotal - discountTotal + taxTotal + shipping;
      const costTotal = itemRows.every((i) => i.v.cost !== null) ? itemRows.reduce((s, i) => s + i.v.cost! * i.qty, 0) : null;

      // ¿Qué pasó con el pedido?
      const online = method === 'card' || method === 'deuna' || method === 'pichincha';
      const isCancelled = chance(0.045);
      const paidAt = isCancelled && method !== 'cod' ? null : online ? placedAt + int(1, 5) * MIN : method === 'transfer' ? placedAt + int(25, 360) * MIN : null;
      const start = method === 'cod' ? placedAt : paidAt ?? placedAt;
      const rider = fulfillment === 'rider' ? (chance(0.9) ? pick(ridersByZone(zoneKey)) : pick(riders)) : null;

      // Promesa y tiempos de la entrega.
      let promised: number | null = null;
      let assignedAt: number | null = null;
      let pickedUpAt: number | null = null;
      let deliveredAt: number | null = null;
      let failedAt: number | null = null;
      if (!isCancelled) {
        if (fulfillment === 'rider') {
          const startLocalHour = (start - dayStart) / HOUR;
          const cutoff = zoneKey === 'norte' ? 14 : 12;
          let slotDay = startLocalHour < cutoff ? dayStart : dayStart + DAY;
          let window = SLOT_WINDOWS.find(([from]) => slotDay + from * HOUR >= start + 2 * HOUR) ?? null;
          if (!window) {
            slotDay += DAY;
            window = SLOT_WINDOWS[int(0, 1)];
          }
          const slotStart = slotDay + window[0] * HOUR;
          promised = slotDay + window[1] * HOUR;
          assignedAt = Math.max(start + int(15, 60) * MIN, slotStart - int(60, 100) * MIN);
          pickedUpAt = assignedAt + int(10, 35) * MIN;
          if (chance(0.04)) {
            failedAt = Math.max(pickedUpAt + int(20, 50) * MIN, slotStart + int(10, 60) * MIN);
            deliveredAt = failedAt + DAY + int(-90, 90) * MIN;
          } else if (chance(rider!.onTime)) {
            deliveredAt = Math.max(pickedUpAt + int(15, 40) * MIN, slotStart + int(15, (window[1] - window[0]) * 60 - 10) * MIN);
            if (deliveredAt > promised) deliveredAt = promised - int(1, 8) * MIN;
          } else {
            deliveredAt = promised + int(10, 150) * MIN;
          }
        } else if (fulfillment === 'courier') {
          const sla = service(express ? 'EXPRESS' : 'ESTANDAR').sla_hours;
          promised = start + sla * HOUR;
          assignedAt = start + int(60, 240) * MIN;
          pickedUpAt = assignedAt + int(60, 300) * MIN;
          deliveredAt = chance(0.9) ? pickedUpAt + int(10, Math.max(11, sla - 8)) * HOUR : promised + int(2, 20) * HOUR;
        } else {
          pickedUpAt = start + int(2, 5) * HOUR; // listo para retiro
          deliveredAt = pickedUpAt + int(4, 48) * HOUR;
        }
        // Lo que todavía no ocurrió no se registra como entregado: los pedidos de ayer de noche salen hoy.
        if (deliveredAt! > now - 30 * MIN) deliveredAt = now - int(30, 120) * MIN;
        if (pickedUpAt! > deliveredAt!) pickedUpAt = deliveredAt! - int(15, 40) * MIN;
        if (assignedAt !== null && assignedAt > pickedUpAt!) assignedAt = pickedUpAt! - int(5, 20) * MIN;
        if (failedAt !== null && failedAt > deliveredAt!) failedAt = null;
      }
      const deliveredPaidAt = method === 'cod' && deliveredAt ? deliveredAt : paidAt;

      // Devolución (completa y reembolsada) en una parte de lo entregado hace más de una semana.
      const returnable = deliveredAt !== null && deliveredAt < now - 7 * DAY;
      const returnRate = itemRows.some((i) => /jeans|pantalones/.test(i.v.category)) ? 0.09 : itemRows.some((i) => /vestidos|faldas/.test(i.v.category)) ? 0.07 : 0.04;
      const ret = returnable && chance(returnRate) ? itemRows[int(0, itemRows.length - 1)] : null;
      const retQty = ret ? ret.qty : 0;
      const allReturned = ret !== null && itemRows.length === 1;
      const status = isCancelled ? 'cancelled' : ret ? (allReturned ? 'returned' : 'partially_returned') : 'delivered';
      const paymentStatus = isCancelled
        ? online
          ? 'failed'
          : 'pending'
        : ret
          ? allReturned
            ? 'refunded'
            : 'partially_refunded'
          : 'paid';

      const shippingAddress = fulfillment === 'pickup' ? null : address;
      orders.push([
        orderId, tenantId, customer?.userId ?? null, null,
        JSON.stringify({ name, email, phone }),
        JSON.stringify({ idType: customer || chance(0.6) ? '05' : '07', idNumber: customer?.idNumber ?? (chance(0.6) ? cedula() : '9999999999999'), name }),
        status, paymentStatus, method, fulfillment,
        shippingAddress ? JSON.stringify(shippingAddress) : null,
        shippingAddress ? point(address.lat, address.lng) : null,
        shippingAddress ? address.city : null,
        fulfillment === 'pickup' ? null : zones[zoneKey],
        dev.warehouseId,
        money(subtotal), money(discountTotal), money(shipping), money(taxTotal), money(total), costTotal === null ? null : money(costTotal),
        channel, channel === 'backoffice' || channel === 'whatsapp' ? seller : null,
        JSON.stringify({ source: weighted([['instagram', 35], ['google', 25], ['directo', 20], ['facebook', 12], ['tiktok', 8]] as const), seed: 'demo' }),
        isCancelled ? cancelReason(method) : null,
        new Date(placedAt), deliveredPaidAt ? new Date(deliveredPaidAt) : null,
        pickedUpAt && !isCancelled ? new Date(pickedUpAt) : null,
        deliveredAt ? new Date(deliveredAt) : null,
        isCancelled ? new Date(placedAt + (method === 'transfer' ? DAY : int(10, 40) * MIN)) : null,
        new Date(Math.max(placedAt, deliveredAt ?? placedAt)),
      ]);
      for (const i of itemRows) {
        items.push([
          i.id, orderId, i.v.id, i.v.productId, i.v.sku, i.v.productName, i.v.brand, i.v.category, i.v.color, i.v.size, i.qty,
          money(i.v.price), money(i.discount), '4', '15.00', money(i.tax), money(i.lineTotal), i.v.cost === null ? null : money(i.v.cost),
          dev.warehouseId, ret?.id === i.id ? retQty : 0,
        ]);
      }

      // Historial de estados.
      const h = (from: string | null, to: string, at: number, actor: string, actorId: string | null, reason: string | null = null) =>
        history.push([orderId, from, to, actor, actorId, reason, new Date(at)]);
      h(null, 'created', placedAt, customer ? 'customer' : 'system', customer?.userId ?? null);
      if (isCancelled) {
        h('created', 'cancelled', placedAt + (method === 'transfer' ? DAY : int(10, 40) * MIN), 'system', null, cancelReason(method));
      } else {
        let prev = 'created';
        if (paidAt) {
          h(prev, 'paid', paidAt, method === 'transfer' ? 'staff' : 'system', method === 'transfer' ? dev.credentials.find((c) => c.role === 'logistics')!.userId : null);
          prev = 'paid';
        }
        h(prev, 'preparing', Math.min(start + int(10, 50) * MIN, pickedUpAt! - 5 * MIN), 'staff', warehouseStaff);
        h('preparing', 'shipped', pickedUpAt!, fulfillment === 'rider' ? 'rider' : 'staff', fulfillment === 'rider' ? rider!.userId : warehouseStaff);
        h('shipped', 'in_transit', pickedUpAt! + int(1, 5) * MIN, fulfillment === 'rider' ? 'rider' : fulfillment === 'courier' ? 'courier' : 'staff', rider?.userId ?? null);
        h('in_transit', 'delivered', deliveredAt!, fulfillment === 'rider' ? 'rider' : fulfillment === 'courier' ? 'courier' : 'staff', rider?.userId ?? null);
      }

      // Pago.
      const paymentId = uuid();
      const provider = online ? 'simulator' : 'manual';
      payments.push([
        paymentId, tenantId, orderId, method, provider, money(total),
        isCancelled ? (online ? 'failed' : method === 'transfer' ? 'expired' : 'cancelled') : ret ? (allReturned ? 'refunded' : 'partially_refunded') : 'captured',
        online ? `sim_${hex(24)}` : null,
        method === 'card' && !isCancelled ? String(int(100000, 999999)) : null,
        method === 'card' ? pick(['visa', 'mastercard', 'diners']) : null,
        method === 'card' ? String(int(1000, 9999)) : null,
        `seed-demo-${orderId}`,
        isCancelled && online ? 'card_declined' : null,
        method === 'card' && !isCancelled ? money(Math.round(total * 0.045)) : null,
        deliveredPaidAt ? new Date(deliveredPaidAt) : null,
        new Date(placedAt),
        new Date(deliveredPaidAt ?? placedAt),
      ]);

      // Envío.
      const shipmentId = uuid();
      const codCollected = method === 'cod' && deliveredAt ? total : null;
      const courier = fulfillment === 'courier' ? service(express ? 'EXPRESS' : 'ESTANDAR') : null;
      const fee = fulfillment === 'rider' ? Math.round(250 + 30 * km) : fulfillment === 'courier' ? (express ? 500 : 350) : 0;
      shipments.push([
        shipmentId, tenantId, orderId, 'outbound', fulfillment, rider?.riderId ?? null, courier?.id ?? null,
        courier ? `SIM${String(int(10000000, 99999999))}` : null, trackingToken(),
        isCancelled ? 'cancelled' : 'delivered', dev.warehouseId,
        JSON.stringify({ ...address, recipientName: name, phone }), point(address.lat, address.lng),
        fulfillment === 'pickup' ? null : zones[zoneKey],
        fulfillment === 'pickup' ? null : Math.round(km * 1000), weightG, money(shipping), fulfillment === 'pickup' ? null : money(fee),
        money(method === 'cod' ? total : 0), codCollected === null ? null : money(codCollected), codCollected === null ? null : weighted([['cash', 80], ['deuna_qr', 15], ['card_pos', 5]] as const),
        failedAt ? 2 : isCancelled ? 0 : 1,
        promised ? new Date(promised) : null,
        assignedAt && !isCancelled ? new Date(assignedAt) : null,
        pickedUpAt && !isCancelled ? new Date(pickedUpAt) : null,
        deliveredAt ? new Date(deliveredAt) : null,
        new Date(placedAt), new Date(deliveredAt ?? placedAt + 30 * MIN),
      ]);
      if (!isCancelled) {
        const e = (st: string, at: number, source: string, description: string | null = null, loc: string | null = null) =>
          events.push([shipmentId, st, description, loc, source, new Date(at)]);
        if (fulfillment === 'pickup') {
          e('ready_for_pickup', pickedUpAt!, 'staff', 'Listo para retirar en Bodega Quito Norte');
          e('delivered', deliveredAt!, 'staff', 'Retirado por el cliente');
        } else {
          const src = fulfillment === 'rider' ? 'rider_app' : 'courier_webhook';
          e('assigned', assignedAt!, fulfillment === 'rider' ? 'staff' : 'system');
          e('picked_up', pickedUpAt!, src, null, point(warehouse.lat, warehouse.lng));
          e('in_transit', pickedUpAt! + int(1, 5) * MIN, src);
          if (failedAt) e('failed_attempt', failedAt, src, 'El cliente no estaba en el domicilio');
          e('delivered', deliveredAt!, src, null, point(address.lat, address.lng));
        }
      }

      // Calificación del cliente al motorizado.
      if (rider && customer && deliveredAt && chance(0.62)) {
        const score = Math.max(1, Math.min(5, Math.round(rider.rating + between(-1.4, 0.9))));
        ratings.push([
          shipmentId, 'customer', customer.userId, rider.userId, score,
          score >= 4 ? [...new Set([pick(GOOD_TAGS), pick(GOOD_TAGS)])] : [pick(BAD_TAGS)],
          chance(0.3) ? pick(score >= 4 ? GOOD_COMMENTS : BAD_COMMENTS) : null,
          new Date(deliveredAt + int(10, 2 * 24 * 60) * MIN),
        ]);
      }

      // Devolución y reembolso.
      if (ret && deliveredAt) {
        const returnId = uuid();
        const requestedAt = deliveredAt + int(1, 6) * DAY + int(0, 600) * MIN;
        const closedAt = requestedAt + int(3, 6) * DAY;
        const amount = Math.round((ret.lineTotal * retQty) / ret.qty);
        const reason = weighted(REASONS);
        returns.push({
          orderId,
          row: [returnId, tenantId, orderId, 'return', 'refunded', 'refund_original', reasonText(reason), null, money(amount), 'store', support, new Date(requestedAt), new Date(closedAt)],
        });
        returnItems.push([uuid(), returnId, ret.id, retQty, reason, reason === 'defect' ? 'damaged' : 'new', reason !== 'defect']);
        refunds.push([uuid(), paymentId, returnId, money(amount), method === 'cod' || method === 'transfer' ? 'transfer' : 'original', 'succeeded', online ? `rf_${hex(24)}` : null, reasonText(reason), support, manager, new Date(closedAt - int(60, 600) * MIN), new Date(closedAt)]);
        history.push([orderId, 'delivered', allReturned ? 'returned' : 'partially_returned', 'staff', warehouseStaff, null, new Date(closedAt)]);
      }

      // Carrito convertido (embudo de Reportes).
      const cartId = uuid();
      const cartCreated = placedAt - int(4, 120) * MIN;
      carts.push([cartId, tenantId, customer?.userId ?? null, customer ? null : Buffer.from(hex(64), 'hex'), customer ? null : email, coupon ? ['BIENVENIDA10'] : [], 'converted', 0, new Date(placedAt), new Date(cartCreated)]);
      for (const i of itemRows) cartItems.push([cartId, i.v.id, i.qty, money(i.v.price), new Date(cartCreated + int(1, 3) * MIN)]);
      orders[orders.length - 1][3] = cartId;

      if (customer) {
        firstOrderOf.set(customer.userId, firstOrderOf.get(customer.userId) ?? placedAt);
        if (!isCancelled) {
          const p = profile.get(customer.userId) ?? { count: 0, value: 0, last: 0 };
          profile.set(customer.userId, { count: p.count + 1, value: p.value + total, last: placedAt });
        }
      }
      if (isCancelled) cancelled++;
      else delivered++;
    }

    // Carritos abandonados del día: entre 1,2 y 2 por cada pedido.
    const abandonedToday = Math.round(n * between(1.2, 2));
    for (let i = 0; i < abandonedToday; i++) {
      const customer = chance(0.4) ? pick(customers) : null;
      const created = dayStart + weighted(HOUR_WEIGHTS) * HOUR + int(0, 59) * MIN;
      const contact = customer ? customer.email : chance(0.5) ? `${ascii(pick(FIRST_F))}${int(1, 999)}@correo.test` : null;
      const cartId = uuid();
      carts.push([cartId, tenantId, customer?.userId ?? null, customer ? null : Buffer.from(hex(64), 'hex'), customer ? null : contact, [], 'abandoned', contact ? int(0, 2) : 0, new Date(created + int(2, 40) * MIN), new Date(created)]);
      const seen = new Set<string>();
      for (let k = int(1, 3); k > 0; k--) {
        const v = pickVariant();
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        cartItems.push([cartId, v.id, 1, money(v.price), new Date(created + k * MIN)]);
      }
      abandoned++;
    }
  }

  // ---- escritura (en orden de llaves foráneas)
  const numbers = await insertMany(
    db,
    'sales.orders',
    [
      'id', 'tenant_id', 'user_id', 'cart_id', 'customer', 'billing', 'status', 'payment_status', 'payment_method', 'fulfillment_type',
      'shipping_address', 'shipping_location', 'shipping_city', 'shipping_zone_id', 'source_warehouse_id',
      'subtotal', 'discount_total', 'shipping_total', 'tax_total', 'total', 'cost_total', 'channel', 'seller_id', 'utm', 'cancel_reason',
      'placed_at', 'paid_at', 'shipped_at', 'delivered_at', 'cancelled_at', 'updated_at',
    ],
    orders,
    'id, order_number',
  );
  const orderNumber = new Map(numbers.map((r) => [r.id as string, String(r.order_number)]));
  await insertMany(
    db,
    'sales.order_items',
    ['id', 'order_id', 'variant_id', 'product_id', 'sku', 'product_name', 'brand_name', 'category_path', 'color_name', 'size_code', 'quantity',
      'unit_price', 'discount', 'tax_code', 'tax_rate', 'tax_amount', 'line_total', 'unit_cost', 'warehouse_id', 'qty_returned'],
    items,
  );
  await insertMany(db, 'sales.order_status_history', ['order_id', 'from_status', 'to_status', 'actor_type', 'actor_id', 'reason', 'created_at'], history);
  await insertMany(
    db,
    'payments.payments',
    ['id', 'tenant_id', 'order_id', 'method', 'provider', 'amount', 'status', 'provider_ref', 'authorization_code', 'card_brand', 'card_last4',
      'idempotency_key', 'failure_code', 'fee_amount', 'captured_at', 'created_at', 'updated_at'],
    payments,
  );
  await insertMany(
    db,
    'logistics.shipments',
    ['id', 'tenant_id', 'order_id', 'direction', 'carrier_type', 'rider_id', 'courier_service_id', 'tracking_number', 'tracking_token', 'status',
      'origin_warehouse_id', 'destination', 'destination_location', 'zone_id', 'distance_m', 'weight_g', 'price_charged', 'carrier_cost',
      'cod_amount', 'cod_collected', 'cod_method', 'attempts', 'eta', 'assigned_at', 'picked_up_at', 'delivered_at', 'created_at', 'updated_at'],
    shipments,
  );
  await insertMany(db, 'logistics.shipment_events', ['shipment_id', 'status', 'description', 'location', 'source', 'occurred_at'], events);
  await insertMany(db, 'logistics.ratings', ['shipment_id', 'rater_type', 'rater_id', 'ratee_id', 'score', 'tags', 'comment', 'created_at'], ratings);
  await insertMany(
    db,
    'sales.returns',
    ['id', 'tenant_id', 'order_id', 'type', 'status', 'resolution', 'reason', 'customer_notes', 'refund_amount', 'return_shipping_paid_by',
      'approved_by', 'created_at', 'closed_at', 'rma_number'],
    returns.map((r) => [...r.row, `RMA-${orderNumber.get(r.orderId)}-1`]),
  );
  await insertMany(db, 'sales.return_items', ['id', 'return_id', 'order_item_id', 'quantity', 'reason_code', 'condition', 'restock'], returnItems);
  await insertMany(
    db,
    'payments.refunds',
    ['id', 'payment_id', 'return_id', 'amount', 'method', 'status', 'provider_ref', 'reason', 'requested_by', 'approved_by', 'created_at', 'completed_at'],
    refunds,
  );
  await insertMany(db, 'sales.carts', ['id', 'tenant_id', 'user_id', 'guest_token_hash', 'contact_email', 'coupon_codes', 'status', 'reminders_sent', 'last_activity_at', 'created_at'], carts);
  await insertMany(db, 'sales.cart_items', ['cart_id', 'variant_id', 'quantity', 'price_at_add', 'added_at'], cartItems);

  // Calificación media de cada motorizado, perfiles de clientes y fecha de alta antes de su primera compra.
  await db.query(
    `UPDATE logistics.riders r SET rating_avg = s.avg, rating_count = s.n
       FROM (SELECT u.id AS user_id, round(avg(rt.score), 2) AS avg, count(*)::int AS n
               FROM logistics.ratings rt JOIN iam.users u ON u.id = rt.ratee_id
              WHERE rt.rater_type = 'customer' AND u.tenant_id = $1 GROUP BY u.id) s
      WHERE r.user_id = s.user_id`,
    [tenantId],
  );
  for (const c of customers) {
    const p = profile.get(c.userId);
    const first = firstOrderOf.get(c.userId);
    await db.query(
      `UPDATE crm.customer_profiles SET orders_count = $2, lifetime_value = $3, last_order_at = $4 WHERE user_id = $1`,
      [c.userId, p?.count ?? 0, money(p?.value ?? 0), p ? new Date(p.last) : null],
    );
    await db.query(`UPDATE iam.users SET created_at = $2 WHERE id = $1`, [c.userId, new Date((first ?? now - 20 * DAY) - int(1, 40) * DAY)]);
  }

  return { days: HISTORY_DAYS, orders: orders.length, delivered, cancelled, returns: returns.length, abandonedCarts: abandoned, ratings: ratings.length };
}

function cancelReason(method: string): string {
  if (method === 'transfer') return 'No se recibió la transferencia a tiempo';
  if (method === 'cod') return 'El cliente canceló por teléfono antes del despacho';
  return 'Pago rechazado por el banco emisor';
}

function reasonText(code: string): string {
  const texts: Record<string, string> = {
    size_small: 'Me quedó pequeña',
    size_large: 'Me quedó grande',
    changed_mind: 'Ya no la quiero',
    defect: 'Tiene una costura abierta',
    not_as_described: 'El color no es como en la foto',
    wrong_item: 'Llegó otra prenda',
  };
  return texts[code] ?? 'Otro motivo';
}

/**
 * Liquidaciones semanales de los motorizados con el servicio real (fees, bonos, efectivo): las semanas
 * cerradas quedan pagadas y la última, aprobada, para que el backoffice muestre historia.
 */
async function settleRiders(app: INestApplicationContext, db: Client, tenantId: string): Promise<void> {
  const settlements = app.get(SettlementService);
  const now = new Date();
  const local = new Date(now.getTime() - LOCAL_OFFSET);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const thisMonday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - daysSinceMonday * DAY;
  const weeks = Math.ceil(HISTORY_DAYS / 7) + 1;
  for (let w = weeks; w >= 1; w--) {
    const periodStart = new Date(thisMonday - w * 7 * DAY).toISOString().slice(0, 10);
    await settlements.generate({ tenantId, periodStart, now });
  }
  const lastWeek = new Date(thisMonday - 7 * DAY).toISOString().slice(0, 10);
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM iam.users WHERE tenant_id = $1 AND email = 'gerente@demo.test'`, [tenantId]);
  await db.query(
    `UPDATE logistics.rider_settlements s
        SET status = CASE WHEN s.period_start < $3::date THEN 'paid' ELSE 'approved' END,
            approved_by = $2, cod_remitted = s.cod_collected,
            paid_at = CASE WHEN s.period_start < $3::date THEN (s.period_end + 3)::timestamptz + interval '15 hours' END
       FROM logistics.riders r
      WHERE r.id = s.rider_id AND r.tenant_id = $1 AND s.status = 'draft'`,
    [tenantId, rows[0]?.id ?? null, lastWeek],
  );
  // Lo cobrado esta semana todavía está en manos de cada motorizado.
  await db.query(
    `UPDATE logistics.riders r
        SET cod_balance = COALESCE((SELECT sum(sh.cod_collected) FROM logistics.shipments sh
                                     WHERE sh.rider_id = r.id AND sh.delivered_at >= $2 AND sh.cod_collected IS NOT NULL), 0)
      WHERE r.tenant_id = $1`,
    [tenantId, new Date(thisMonday + LOCAL_OFFSET)],
  );
}

/** Las vistas de Reportes se refrescan cada 15 min en el worker; aquí, en el acto, para ver el dashboard enseguida. */
async function refreshReports(db: Client): Promise<void> {
  for (const view of ['mv_sales_daily', 'mv_sales_items_daily', 'mv_delivery_performance', 'mv_funnel_daily']) {
    const started = Date.now();
    await db.query(`REFRESH MATERIALIZED VIEW reports.${view}`);
    await db.query(`UPDATE reports.refresh_log SET refreshed_at = now(), duration_ms = $2 WHERE view_name = $1`, [view, Date.now() - started]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
