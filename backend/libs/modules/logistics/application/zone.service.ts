import { Injectable } from '@nestjs/common';
import { Database } from '../../../shared-kernel';
import { InventoryApi } from '../../inventory';
import { WarehouseUnavailableError, ZoneNotFoundError } from '../domain/errors';
import { assertValidPoint, GeoPoint, InvalidAreaError, MultiPolygon, normalizeArea } from '../domain/geo';
import { assertValidZone, CoverageZone, DeliveryMode, normalizeTime, ZoneProps } from '../domain/zone';
import { ZoneFilter, ZoneRepository } from './ports';

export interface CreateZoneInput {
  name: string;
  city: string;
  /** GeoJSON Polygon, MultiPolygon o Feature con una de esas geometrías. */
  area: unknown;
  deliveryMode: DeliveryMode;
  priority?: number;
  baseFee: string;
  feePerKm?: string;
  feePerExtraKg?: string;
  maxWeightKg?: number;
  freeShippingThreshold?: string | null;
  sameDayCutoff?: string | null;
  servingWarehouseId?: string | null;
}

export type UpdateZoneInput = Partial<CreateZoneInput> & { active?: boolean };

/** CRUD de zonas de cobertura. El área se valida dos veces: estructura (dominio) y topología (PostGIS). */
@Injectable()
export class ZoneService {
  constructor(
    private readonly db: Database,
    private readonly zones: ZoneRepository,
    private readonly inventory: InventoryApi,
  ) {}

  async create(tenantId: string, input: CreateZoneInput): Promise<CoverageZone> {
    const props: ZoneProps = {
      name: input.name.trim(),
      city: input.city.trim(),
      area: normalizeArea(input.area),
      deliveryMode: input.deliveryMode,
      priority: input.priority ?? 100,
      baseFee: input.baseFee,
      feePerKm: input.feePerKm ?? '0',
      feePerExtraKg: input.feePerExtraKg ?? '0',
      maxWeightKg: input.maxWeightKg ?? 15,
      freeShippingThreshold: input.freeShippingThreshold ?? null,
      sameDayCutoff: input.sameDayCutoff ? normalizeTime(input.sameDayCutoff, 'sameDayCutoff') : null,
      servingWarehouseId: input.servingWarehouseId ?? null,
      active: true,
    };
    await this.validate(tenantId, props, { area: true, warehouse: true });
    return this.zones.insert(this.db, tenantId, props);
  }

  async get(tenantId: string, id: string): Promise<CoverageZone> {
    const zone = await this.zones.findById(this.db, tenantId, id);
    if (!zone) throw new ZoneNotFoundError(id);
    return zone;
  }

  list(tenantId: string, filter: ZoneFilter): Promise<CoverageZone[]> {
    return this.zones.list(this.db, tenantId, filter);
  }

  async update(tenantId: string, id: string, patch: UpdateZoneInput): Promise<CoverageZone> {
    const { id: _id, tenantId: _t, ...current } = await this.get(tenantId, id);
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as UpdateZoneInput;
    const merged: ZoneProps = {
      ...current,
      ...defined,
      name: (defined.name ?? current.name).trim(),
      city: (defined.city ?? current.city).trim(),
      area: defined.area !== undefined ? normalizeArea(defined.area) : current.area,
      sameDayCutoff:
        defined.sameDayCutoff !== undefined
          ? defined.sameDayCutoff
            ? normalizeTime(defined.sameDayCutoff, 'sameDayCutoff')
            : null
          : current.sameDayCutoff,
    };
    await this.validate(tenantId, merged, {
      area: defined.area !== undefined,
      warehouse: defined.servingWarehouseId !== undefined || defined.deliveryMode !== undefined,
    });
    const updated = await this.zones.update(this.db, tenantId, id, merged);
    if (!updated) throw new ZoneNotFoundError(id);
    return updated;
  }

  /** Borrado lógico: pedidos, envíos y franjas históricos siguen apuntando a la zona. */
  deactivate(tenantId: string, id: string): Promise<CoverageZone> {
    return this.update(tenantId, id, { active: false });
  }

  /** ZoneResolver (PostGIS ST_Covers). null si el punto no cae en ninguna zona activa. */
  resolve(tenantId: string, point: GeoPoint): Promise<CoverageZone | null> {
    assertValidPoint(point);
    return this.zones.resolve(this.db, tenantId, point);
  }

  private async validate(tenantId: string, z: ZoneProps, check: { area: boolean; warehouse: boolean }): Promise<void> {
    assertValidZone(z);
    if (check.area) await this.assertValidArea(z.area);
    if (check.warehouse && z.servingWarehouseId) {
      const warehouses = await this.inventory.listShippingWarehouses(tenantId);
      if (!warehouses.some((w) => w.id === z.servingWarehouseId)) throw new WarehouseUnavailableError(z.servingWarehouseId);
    }
  }

  private async assertValidArea(area: MultiPolygon): Promise<void> {
    const problem = await this.zones.areaProblem(this.db, area);
    if (problem) throw new InvalidAreaError(`PostGIS considera inválida el área: ${problem}`, { reason: problem });
  }
}
