/**
 * Datos de Logística para desarrollo y tests: 3 zonas de cobertura reales de Quito, sus
 * plantillas de franjas, el courier simulado con dos servicios y su tarifario
 * (courier_rate_cards). Lo usa `npm run seed:dev`; los tests de integración cargan lo mismo.
 *
 * Los polígonos están trazados a mano sobre OpenStreetMap siguiendo avenidas principales. Son
 * APROXIMADOS: sirven para la demo, no son límites oficiales de barrios ni parroquias.
 * Coordenadas GeoJSON: [longitud, latitud].
 *
 * Idempotente: las zonas se identifican por (tenant, nombre); el courier por (tenant, código).
 */
import { Queryable } from '../libs/shared-kernel';

export interface SeedZone {
  key: 'norte' | 'centro' | 'cumbaya';
  name: string;
  city: string;
  deliveryMode: 'rider' | 'courier' | 'both';
  priority: number;
  baseFee: string;
  feePerKm: string;
  feePerExtraKg: string;
  maxWeightKg: number;
  freeShippingThreshold: string | null;
  sameDayCutoff: string | null;
  area: { type: 'Polygon'; coordinates: number[][][] };
  /** Punto de ejemplo dentro de la zona (para la demo y los tests). */
  samplePoint: { lat: number; lng: number; label: string };
  templates: { weekday: number; startTime: string; endTime: string; capacity: number; surcharge: string }[];
}

const MON_SAT = [1, 2, 3, 4, 5, 6];
const MON_FRI = [1, 2, 3, 4, 5];

export const QUITO_ZONES: SeedZone[] = [
  {
    key: 'norte',
    name: 'Quito Norte · La Carolina, Iñaquito y Bicentenario',
    city: 'Quito',
    deliveryMode: 'rider',
    priority: 10,
    baseFee: '2.50',
    feePerKm: '0.35',
    feePerExtraKg: '0.50',
    maxWeightKg: 15,
    freeShippingThreshold: '60.00',
    sameDayCutoff: '14:00',
    // De la Av. Colón (sur) al Parque Bicentenario (norte), entre la Av. América/Occidental
    // (oeste) y la Av. Eloy Alfaro/6 de Diciembre (este).
    area: {
      type: 'Polygon',
      coordinates: [
        [
          [-78.4995, -0.1995],
          [-78.4872, -0.2032],
          [-78.4762, -0.1962],
          [-78.4712, -0.1790],
          [-78.4698, -0.1600],
          [-78.4778, -0.1380],
          [-78.4918, -0.1330],
          [-78.4998, -0.1500],
          [-78.5042, -0.1722],
          [-78.4995, -0.1995],
        ],
      ],
    },
    samplePoint: { lat: -0.1765, lng: -78.4800, label: 'Centro Comercial Iñaquito (CCI), Av. Amazonas y Naciones Unidas' },
    templates: [
      ...MON_SAT.flatMap((weekday) => [
        { weekday, startTime: '09:00', endTime: '12:00', capacity: 8, surcharge: '0.00' },
        { weekday, startTime: '12:00', endTime: '15:00', capacity: 8, surcharge: '0.00' },
        { weekday, startTime: '15:00', endTime: '18:00', capacity: 8, surcharge: '0.00' },
        { weekday, startTime: '18:00', endTime: '20:00', capacity: 4, surcharge: '1.00' },
      ]),
      { weekday: 0, startTime: '10:00', endTime: '13:00', capacity: 4, surcharge: '1.50' },
    ],
  },
  {
    key: 'centro',
    name: 'Centro Histórico de Quito',
    city: 'Quito',
    deliveryMode: 'rider',
    priority: 20,
    baseFee: '2.00',
    feePerKm: '0.30',
    feePerExtraKg: '0.50',
    maxWeightKg: 10,
    freeShippingThreshold: null,
    sameDayCutoff: '12:00',
    // De la Basílica del Voto Nacional (norte) a La Ronda (sur), entre San Roque (oeste) y
    // La Marín (este). Calles angostas: pocos cupos por franja.
    area: {
      type: 'Polygon',
      coordinates: [
        [
          [-78.5178, -0.2128],
          [-78.5062, -0.2108],
          [-78.5018, -0.2176],
          [-78.5074, -0.2268],
          [-78.5160, -0.2286],
          [-78.5205, -0.2212],
          [-78.5178, -0.2128],
        ],
      ],
    },
    samplePoint: { lat: -0.2203, lng: -78.5122, label: 'Plaza Grande, calles García Moreno y Chile' },
    templates: MON_FRI.flatMap((weekday) => [
      { weekday, startTime: '10:00', endTime: '13:00', capacity: 2, surcharge: '0.00' },
      { weekday, startTime: '14:00', endTime: '17:00', capacity: 2, surcharge: '0.00' },
    ]),
  },
  {
    key: 'cumbaya',
    name: 'Valle de Cumbayá y Tumbaco',
    city: 'Cumbayá',
    deliveryMode: 'courier',
    priority: 30,
    baseFee: '0.00',
    feePerKm: '0.00',
    feePerExtraKg: '0.00',
    maxWeightKg: 30,
    freeShippingThreshold: null,
    sameDayCutoff: null,
    // Del parque de Cumbayá y la USFQ (oeste) al centro de Tumbaco (este). Sin motorizado propio:
    // se atiende por courier.
    area: {
      type: 'Polygon',
      coordinates: [
        [
          [-78.4452, -0.1902],
          [-78.4202, -0.1832],
          [-78.3882, -0.1952],
          [-78.3822, -0.2202],
          [-78.4052, -0.2302],
          [-78.4352, -0.2152],
          [-78.4472, -0.2022],
          [-78.4452, -0.1902],
        ],
      ],
    },
    samplePoint: { lat: -0.2025, lng: -78.4290, label: 'Parque Central de Cumbayá' },
    templates: [],
  },
];

/** Tarifario del courier simulado: la copia negociada de simulators/courier/tariffs.mjs (sin recargo por combustible). */
export const COURIER_SERVICES = [
  { code: 'ESTANDAR', name: 'Estándar', maxWeightKg: 30, slaHours: 48 },
  { code: 'EXPRESS', name: 'Express 24 h', maxWeightKg: 15, slaHours: 24 },
] as const;

type Band = [from: number, to: number, price: string];
export const RATE_CARDS: Record<
  (typeof COURIER_SERVICES)[number]['code'],
  { destProvince: string; destCity: string | null; bands: Band[]; extraKg: string }[]
> = {
  ESTANDAR: [
    { destProvince: 'Pichincha', destCity: 'Quito', bands: [[0, 2, '3.50'], [2, 5, '4.50']], extraKg: '0.50' },
    { destProvince: 'Pichincha', destCity: null, bands: [[0, 2, '4.50'], [2, 5, '5.75']], extraKg: '0.75' },
    { destProvince: 'Guayas', destCity: null, bands: [[0, 2, '6.00'], [2, 5, '7.50']], extraKg: '1.00' },
    { destProvince: 'Azuay', destCity: null, bands: [[0, 2, '6.00'], [2, 5, '7.50']], extraKg: '1.00' },
    { destProvince: '*', destCity: null, bands: [[0, 2, '7.50'], [2, 5, '9.50']], extraKg: '1.25' },
  ],
  EXPRESS: [
    { destProvince: 'Pichincha', destCity: 'Quito', bands: [[0, 2, '5.00'], [2, 5, '6.50']], extraKg: '0.75' },
    { destProvince: 'Pichincha', destCity: null, bands: [[0, 2, '6.50'], [2, 5, '8.00']], extraKg: '1.00' },
    { destProvince: 'Guayas', destCity: null, bands: [[0, 2, '8.50'], [2, 5, '10.50']], extraKg: '1.25' },
    { destProvince: 'Azuay', destCity: null, bands: [[0, 2, '8.50'], [2, 5, '10.50']], extraKg: '1.25' },
    { destProvince: '*', destCity: null, bands: [[0, 2, '10.50'], [2, 5, '13.00']], extraKg: '1.50' },
  ],
};

export interface SeededLogistics {
  zones: Record<SeedZone['key'], string>;
  courierId: string;
  services: Record<string, string>;
}

/**
 * Crea o actualiza una zona (por tenant y nombre) y reemplaza sus plantillas de franjas. La usan
 * seedLogistics (las 3 zonas de los tests) y el seed de demo (zonas adicionales de Quito).
 * `warehouseId` es la bodega que atiende la zona si tiene motorizado.
 */
export async function upsertZone(db: Queryable, tenantId: string, z: Omit<SeedZone, 'key' | 'samplePoint'>, warehouseId: string): Promise<string> {
  const params = [
    tenantId,
    z.name,
    z.city,
    JSON.stringify(z.area),
    z.deliveryMode,
    z.priority,
    z.baseFee,
    z.feePerKm,
    z.feePerExtraKg,
    z.maxWeightKg,
    z.freeShippingThreshold,
    z.sameDayCutoff,
    z.deliveryMode === 'courier' ? null : warehouseId,
  ];
  const existing = await db.query<{ id: string }>(`SELECT id FROM logistics.coverage_zones WHERE tenant_id = $1 AND name = $2`, [
    tenantId,
    z.name,
  ]);
  const area = `ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))::geography`;
  const { rows } = existing.rows[0]
    ? await db.query<{ id: string }>(
        `UPDATE logistics.coverage_zones
            SET city = $3, area = ${area}, delivery_mode = $5, priority = $6, base_fee = $7, fee_per_km = $8,
                fee_per_extra_kg = $9, max_weight_kg = $10, free_shipping_threshold = $11, same_day_cutoff = $12::time,
                serving_warehouse_id = $13, active = true
          WHERE tenant_id = $1 AND name = $2 RETURNING id`,
        params,
      )
    : await db.query<{ id: string }>(
        `INSERT INTO logistics.coverage_zones
           (tenant_id, name, city, area, delivery_mode, priority, base_fee, fee_per_km, fee_per_extra_kg,
            max_weight_kg, free_shipping_threshold, same_day_cutoff, serving_warehouse_id)
         VALUES ($1, $2, $3, ${area}, $5, $6, $7, $8, $9, $10, $11, $12::time, $13) RETURNING id`,
        params,
      );
  const zoneId = rows[0].id;

  // Plantillas: se reemplazan (las franjas ya generadas y sus reservas no se tocan).
  await db.query(`DELETE FROM logistics.delivery_slot_templates WHERE zone_id = $1`, [zoneId]);
  for (const t of z.templates) {
    await db.query(
      `INSERT INTO logistics.delivery_slot_templates (zone_id, weekday, start_time, end_time, capacity, surcharge)
       VALUES ($1, $2, $3::time, $4::time, $5, $6)`,
      [zoneId, t.weekday, t.startTime, t.endTime, t.capacity, t.surcharge],
    );
  }
  return zoneId;
}

/**
 * Carga (o actualiza) las zonas, plantillas, courier y tarifario del tenant. `warehouseId` es la
 * bodega de Quito que atiende las zonas con motorizado; `originCity` la ciudad de esa bodega.
 * No genera franjas: eso lo hace SlotService (el seed lo llama después, o el job del worker).
 */
export async function seedLogistics(db: Queryable, tenantId: string, warehouseId: string, originCity = 'Quito'): Promise<SeededLogistics> {
  const zones = {} as Record<SeedZone['key'], string>;
  for (const z of QUITO_ZONES) zones[z.key] = await upsertZone(db, tenantId, z, warehouseId);

  const courier = await db.query<{ id: string }>(
    `INSERT INTO logistics.couriers (tenant_id, code, name, adapter, secret_ref, supports_cod, supports_pickup, tracking_mode)
     VALUES ($1, 'simulador', 'Courier Simulado', 'simulator', 'env:COURIERSIM_SECRET', true, true, 'webhook')
     ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, adapter = EXCLUDED.adapter, active = true
     RETURNING id`,
    [tenantId],
  );
  const courierId = courier.rows[0].id;
  const services: Record<string, string> = {};
  for (const s of COURIER_SERVICES) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO logistics.courier_services (courier_id, code, name, max_weight_kg, sla_hours)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (courier_id, code) DO UPDATE
         SET name = EXCLUDED.name, max_weight_kg = EXCLUDED.max_weight_kg, sla_hours = EXCLUDED.sla_hours, active = true
       RETURNING id`,
      [courierId, s.code, s.name, s.maxWeightKg, s.slaHours],
    );
    services[s.code] = rows[0].id;
    // courier_rate_cards no tiene clave natural: se reemplaza el tarifario del servicio y origen.
    await db.query(`DELETE FROM logistics.courier_rate_cards WHERE courier_service_id = $1 AND origin_city = $2`, [rows[0].id, originCity]);
    for (const rc of RATE_CARDS[s.code]) {
      for (const [from, to, price] of rc.bands) {
        await db.query(
          `INSERT INTO logistics.courier_rate_cards
             (courier_service_id, origin_city, dest_province, dest_city, weight_from_kg, weight_to_kg, price, extra_kg_price, valid_from)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2026-01-01')`,
          [rows[0].id, originCity, rc.destProvince, rc.destCity, from, to, price, rc.extraKg],
        );
      }
    }
  }
  return { zones, courierId, services };
}
