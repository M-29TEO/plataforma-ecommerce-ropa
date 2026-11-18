import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { ZoneFilter, ZoneRepository } from '../application/ports';
import { GeoPoint, MultiPolygon } from '../domain/geo';
import { CoverageZone, DeliveryMode, ZoneProps } from '../domain/zone';

const COLUMNS = `
  id, tenant_id, name, city, ST_AsGeoJSON(area::geometry, 7)::json AS area, delivery_mode, priority,
  base_fee, fee_per_km, fee_per_extra_kg, max_weight_kg, free_shipping_threshold,
  to_char(same_day_cutoff, 'HH24:MI') AS same_day_cutoff, serving_warehouse_id, active`;

/** GeoJSON (MultiPolygon, [lng, lat]) → geography(MultiPolygon, 4326). */
const area = (param: number) => `ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($${param}), 4326))::geography`;
const point = (lngParam: number, latParam: number) => `ST_SetSRID(ST_MakePoint($${lngParam}, $${latParam}), 4326)::geography`;

interface ZoneRow {
  id: string;
  tenant_id: string;
  name: string;
  city: string;
  area: MultiPolygon;
  delivery_mode: DeliveryMode;
  priority: number;
  base_fee: string;
  fee_per_km: string;
  fee_per_extra_kg: string;
  max_weight_kg: string;
  free_shipping_threshold: string | null;
  same_day_cutoff: string | null;
  serving_warehouse_id: string | null;
  active: boolean;
}

function toZone(r: ZoneRow): CoverageZone {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    city: r.city,
    area: r.area,
    deliveryMode: r.delivery_mode,
    priority: r.priority,
    baseFee: r.base_fee,
    feePerKm: r.fee_per_km,
    feePerExtraKg: r.fee_per_extra_kg,
    maxWeightKg: Number(r.max_weight_kg),
    freeShippingThreshold: r.free_shipping_threshold,
    sameDayCutoff: r.same_day_cutoff,
    servingWarehouseId: r.serving_warehouse_id,
    active: r.active,
  };
}

const values = (z: ZoneProps) => [
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
  z.servingWarehouseId,
  z.active,
];

@Injectable()
export class PgZoneRepository extends ZoneRepository {
  async insert(q: Queryable, tenantId: string, z: ZoneProps): Promise<CoverageZone> {
    const { rows } = await q.query<ZoneRow>(
      `INSERT INTO logistics.coverage_zones
         (tenant_id, name, city, area, delivery_mode, priority, base_fee, fee_per_km, fee_per_extra_kg,
          max_weight_kg, free_shipping_threshold, same_day_cutoff, serving_warehouse_id, active)
       VALUES ($1, $2, $3, ${area(4)}, $5, $6, $7, $8, $9, $10, $11, $12::time, $13, $14)
       RETURNING ${COLUMNS}`,
      [tenantId, ...values(z)],
    );
    return toZone(rows[0]);
  }

  async update(q: Queryable, tenantId: string, id: string, z: ZoneProps): Promise<CoverageZone | null> {
    const { rows } = await q.query<ZoneRow>(
      `UPDATE logistics.coverage_zones
          SET name = $3, city = $4, area = ${area(5)}, delivery_mode = $6, priority = $7, base_fee = $8,
              fee_per_km = $9, fee_per_extra_kg = $10, max_weight_kg = $11, free_shipping_threshold = $12,
              same_day_cutoff = $13::time, serving_warehouse_id = $14, active = $15
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${COLUMNS}`,
      [tenantId, id, ...values(z)],
    );
    return rows[0] ? toZone(rows[0]) : null;
  }

  async findById(q: Queryable, tenantId: string, id: string): Promise<CoverageZone | null> {
    const { rows } = await q.query<ZoneRow>(`SELECT ${COLUMNS} FROM logistics.coverage_zones WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      id,
    ]);
    return rows[0] ? toZone(rows[0]) : null;
  }

  async list(q: Queryable, tenantId: string, filter: ZoneFilter): Promise<CoverageZone[]> {
    const where = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (filter.active !== undefined) where.push(`active = $${params.push(filter.active)}`);
    if (filter.city) where.push(`lower(city) = lower($${params.push(filter.city)})`);
    const { rows } = await q.query<ZoneRow>(
      `SELECT ${COLUMNS} FROM logistics.coverage_zones WHERE ${where.join(' AND ')} ORDER BY priority, name`,
      params,
    );
    return rows.map(toZone);
  }

  async resolve(q: Queryable, tenantId: string, p: GeoPoint): Promise<CoverageZone | null> {
    // ST_Covers (a diferencia de ST_Contains) incluye el borde: una casa sobre la línea de la
    // zona queda cubierta. Usa el índice GiST ix_zones_area.
    const { rows } = await q.query<ZoneRow>(
      `SELECT ${COLUMNS} FROM logistics.coverage_zones
        WHERE tenant_id = $1 AND active AND ST_Covers(area, ${point(2, 3)})
        ORDER BY priority, id
        LIMIT 1`,
      [tenantId, p.lng, p.lat],
    );
    return rows[0] ? toZone(rows[0]) : null;
  }

  async areaProblem(q: Queryable, a: MultiPolygon): Promise<string | null> {
    const { rows } = await q.query<{ valid: boolean; reason: string }>(
      `SELECT ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason
         FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) x`,
      [JSON.stringify(a)],
    );
    return rows[0].valid ? null : rows[0].reason;
  }

  async listRiderZones(q: Queryable): Promise<{ tenantId: string; zoneId: string; sameDayCutoff: string | null }[]> {
    const { rows } = await q.query<{ tenant_id: string; id: string; same_day_cutoff: string | null }>(
      `SELECT tenant_id, id, to_char(same_day_cutoff, 'HH24:MI') AS same_day_cutoff
         FROM logistics.coverage_zones
        WHERE active AND delivery_mode IN ('rider', 'both')
        ORDER BY tenant_id, id`,
    );
    return rows.map((r) => ({ tenantId: r.tenant_id, zoneId: r.id, sameDayCutoff: r.same_day_cutoff }));
  }
}
