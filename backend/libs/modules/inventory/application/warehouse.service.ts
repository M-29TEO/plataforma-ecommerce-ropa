import { Injectable } from '@nestjs/common';
import { Database, ValidationError } from '../../../shared-kernel';
import { WarehouseNotFoundError } from '../domain/errors';
import { assertValidPoint, GeoPoint, normalizeWarehouseCode, Warehouse, WarehouseType } from '../domain/warehouse';
import { WarehouseFilter, WarehousePatch, WarehouseRepository } from './ports';

export interface CreateWarehouseInput {
  code: string;
  name: string;
  type: WarehouseType;
  address: Record<string, unknown>;
  location: GeoPoint;
  city: string;
  isPickupPoint?: boolean;
  shipsOnline?: boolean;
}

export const MAX_NEARBY_RADIUS_KM = 500;

@Injectable()
export class WarehouseService {
  constructor(
    private readonly db: Database,
    private readonly warehouses: WarehouseRepository,
  ) {}

  create(tenantId: string, input: CreateWarehouseInput): Promise<Warehouse> {
    assertValidPoint(input.location);
    return this.warehouses.insert(this.db, {
      tenantId,
      code: normalizeWarehouseCode(input.code),
      name: input.name.trim(),
      type: input.type,
      address: input.address,
      location: input.location,
      city: input.city.trim(),
      isPickupPoint: input.isPickupPoint ?? false,
      shipsOnline: input.shipsOnline ?? true,
      active: true,
    });
  }

  async get(tenantId: string, id: string): Promise<Warehouse> {
    const warehouse = await this.warehouses.findById(this.db, tenantId, id);
    if (!warehouse) throw new WarehouseNotFoundError(id);
    return warehouse;
  }

  list(tenantId: string, filter: WarehouseFilter): Promise<Warehouse[]> {
    return this.warehouses.list(this.db, tenantId, filter);
  }

  async update(tenantId: string, id: string, patch: WarehousePatch): Promise<Warehouse> {
    if (patch.location) assertValidPoint(patch.location);
    const updated = await this.warehouses.update(this.db, tenantId, id, patch);
    if (!updated) throw new WarehouseNotFoundError(id);
    return updated;
  }

  /**
   * Borrado lógico: el stock, el ledger y los pedidos históricos siguen apuntando a la bodega.
   * Una bodega inactiva no acepta reservas ni ajustes.
   */
  deactivate(tenantId: string, id: string): Promise<Warehouse> {
    return this.update(tenantId, id, { active: false });
  }

  /** Bodegas activas más cercanas a un punto (PostGIS ST_DWithin + KNN). */
  nearby(tenantId: string, point: GeoPoint, radiusKm: number, limit = 10) {
    assertValidPoint(point);
    if (!(radiusKm > 0 && radiusKm <= MAX_NEARBY_RADIUS_KM)) {
      throw new ValidationError('INVALID_RADIUS', `El radio debe estar entre 0 y ${MAX_NEARBY_RADIUS_KM} km`);
    }
    return this.warehouses.findNearby(this.db, tenantId, point, radiusKm * 1000, Math.min(Math.max(limit, 1), 50));
  }
}
