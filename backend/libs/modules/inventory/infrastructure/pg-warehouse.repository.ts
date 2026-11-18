import { Injectable } from '@nestjs/common';
import { buildSetClause, ConflictError, isUniqueViolation, Queryable } from '../../../shared-kernel';
import { NewWarehouse, WarehouseFilter, WarehousePatch, WarehouseRepository } from '../application/ports';
import { GeoPoint, Warehouse } from '../domain/warehouse';

const COLUMNS = `
  id, tenant_id, code, name, type, address,
  ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
  city, is_pickup_point, ships_online, active`;

/** Punto geography a partir de dos parámetros ($lng, $lat): PostGIS usa el orden x, y. */
const point = (lngParam: number, latParam: number) =>
  `ST_SetSRID(ST_MakePoint($${lngParam}, $${latParam}), 4326)::geography`;

const PATCH_COLUMNS: Record<string, string> = {
  name: 'name',
  type: 'type',
  address: 'address',
  city: 'city',
  isPickupPoint: 'is_pickup_point',
  shipsOnline: 'ships_online',
  active: 'active',
};

interface WarehouseRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  type: Warehouse['type'];
  address: Record<string, unknown>;
  lat: number;
  lng: number;
  city: string;
  is_pickup_point: boolean;
  ships_online: boolean;
  active: boolean;
}

function toWarehouse(r: WarehouseRow): Warehouse {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    name: r.name,
    type: r.type,
    address: r.address,
    location: { lat: r.lat, lng: r.lng },
    city: r.city,
    isPickupPoint: r.is_pickup_point,
    shipsOnline: r.ships_online,
    active: r.active,
  };
}

@Injectable()
export class PgWarehouseRepository extends WarehouseRepository {
  async insert(q: Queryable, w: NewWarehouse): Promise<Warehouse> {
    try {
      const { rows } = await q.query<WarehouseRow>(
        `INSERT INTO inventory.warehouses
           (tenant_id, code, name, type, address, location, city, is_pickup_point, ships_online, active)
         VALUES ($1, $2, $3, $4, $5::jsonb, ${point(6, 7)}, $8, $9, $10, $11)
         RETURNING ${COLUMNS}`,
        [
          w.tenantId,
          w.code,
          w.name,
          w.type,
          JSON.stringify(w.address),
          w.location.lng,
          w.location.lat,
          w.city,
          w.isPickupPoint,
          w.shipsOnline,
          w.active,
        ],
      );
      return toWarehouse(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('WAREHOUSE_CODE_TAKEN', `Ya existe una bodega con el código ${w.code}`, { code: w.code });
      }
      throw error;
    }
  }

  async findById(q: Queryable, tenantId: string, id: string): Promise<Warehouse | null> {
    const { rows } = await q.query<WarehouseRow>(
      `SELECT ${COLUMNS} FROM inventory.warehouses WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0] ? toWarehouse(rows[0]) : null;
  }

  async list(q: Queryable, tenantId: string, filter: WarehouseFilter): Promise<Warehouse[]> {
    const where = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (filter.active !== undefined) where.push(`active = $${values.push(filter.active)}`);
    if (filter.city) where.push(`lower(city) = lower($${values.push(filter.city)})`);
    if (filter.type) where.push(`type = $${values.push(filter.type)}`);
    const { rows } = await q.query<WarehouseRow>(
      `SELECT ${COLUMNS} FROM inventory.warehouses WHERE ${where.join(' AND ')} ORDER BY code`,
      values,
    );
    return rows.map(toWarehouse);
  }

  async update(q: Queryable, tenantId: string, id: string, patch: WarehousePatch): Promise<Warehouse | null> {
    const { sql, values } = buildSetClause(patch, PATCH_COLUMNS, 3);
    const sets = sql ? [sql] : [];
    if (patch.location) {
      const lng = values.push(patch.location.lng) + 2;
      const lat = values.push(patch.location.lat) + 2;
      sets.push(`location = ${point(lng, lat)}`);
    }
    if (sets.length === 0) return this.findById(q, tenantId, id);

    const { rows } = await q.query<WarehouseRow>(
      `UPDATE inventory.warehouses SET ${sets.join(', ')}
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${COLUMNS}`,
      [tenantId, id, ...values],
    );
    return rows[0] ? toWarehouse(rows[0]) : null;
  }

  async findNearby(
    q: Queryable,
    tenantId: string,
    p: GeoPoint,
    radiusMeters: number,
    limit: number,
  ): Promise<(Warehouse & { distanceMeters: number })[]> {
    // ST_DWithin usa el índice GiST ix_wh_location; <-> ordena por distancia (KNN).
    const { rows } = await q.query<WarehouseRow & { distance_m: number }>(
      `SELECT ${COLUMNS}, ST_Distance(location, ${point(2, 3)}) AS distance_m
         FROM inventory.warehouses
        WHERE tenant_id = $1 AND active
          AND ST_DWithin(location, ${point(2, 3)}, $4)
        ORDER BY location <-> ${point(2, 3)}
        LIMIT $5`,
      [tenantId, p.lng, p.lat, radiusMeters, limit],
    );
    return rows.map((r) => ({ ...toWarehouse(r), distanceMeters: Math.round(r.distance_m) }));
  }

  async findActiveIds(q: Queryable, tenantId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM inventory.warehouses WHERE tenant_id = $1 AND active AND id = ANY($2::uuid[])`,
      [tenantId, ids],
    );
    return new Set(rows.map((r) => r.id));
  }
}
