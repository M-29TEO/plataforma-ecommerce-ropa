import { Injectable } from '@nestjs/common';
import { Database, OutboxWriter, Queryable, ValidationError } from '../../../shared-kernel';
import {
  InvalidAdjustmentError,
  StaleStockVersionError,
  StockLevelNotFoundError,
  WarehouseInactiveError,
  WarehouseNotFoundError,
} from '../domain/errors';
import { stockBelowThreshold } from '../domain/events';
import { AllocationItem, planAllocation } from '../domain/allocation';
import { ReservationLine } from '../domain/reservation';
import { AdjustmentCommand, crossedBelowThreshold, planAdjustment, StockLevel, StockMovement } from '../domain/stock';
import { CatalogVariants } from './catalog-variants';
import { MovementFilter, StockRepository, StockSettingsPatch, WarehouseRepository } from './ports';

export type AdjustStockInput = AdjustmentCommand & {
  variantId: string;
  warehouseId: string;
  reason: string;
};

export interface AdjustStockResult {
  level: StockLevel;
  delta: number;
}

@Injectable()
export class StockService {
  constructor(
    private readonly db: Database,
    private readonly stock: StockRepository,
    private readonly warehouses: WarehouseRepository,
    private readonly outbox: OutboxWriter,
    private readonly variants: CatalogVariants,
  ) {}

  async getLevel(tenantId: string, variantId: string, warehouseId: string): Promise<StockLevel> {
    await this.assertWarehouseOfTenant(this.db, tenantId, warehouseId);
    const level = await this.stock.find(this.db, variantId, warehouseId);
    if (!level) throw new StockLevelNotFoundError(variantId, warehouseId);
    return level;
  }

  async listByWarehouse(
    tenantId: string,
    warehouseId: string,
    opts: { belowReorderPoint?: boolean; limit: number; offset: number },
  ): Promise<StockLevel[]> {
    await this.assertWarehouseOfTenant(this.db, tenantId, warehouseId);
    return this.stock.listByWarehouse(this.db, warehouseId, opts);
  }

  listByVariant(tenantId: string, variantId: string): Promise<StockLevel[]> {
    return this.stock.listByVariant(this.db, tenantId, variantId);
  }

  /** Configuración de reposición con concurrencia optimista (columna version). */
  async updateSettings(
    tenantId: string,
    variantId: string,
    warehouseId: string,
    expectedVersion: number,
    patch: StockSettingsPatch,
  ): Promise<StockLevel> {
    if (patch.reorderPoint !== undefined && (!Number.isInteger(patch.reorderPoint) || patch.reorderPoint < 0)) {
      throw new ValidationError('INVALID_REORDER_POINT', 'El punto de reorden debe ser un entero >= 0');
    }
    if (patch.reorderQty !== undefined && (!Number.isInteger(patch.reorderQty) || patch.reorderQty <= 0)) {
      throw new ValidationError('INVALID_REORDER_QTY', 'La cantidad de reposición debe ser un entero > 0');
    }
    await this.assertWarehouseOfTenant(this.db, tenantId, warehouseId);
    await this.variants.assertOfTenant(tenantId, [variantId]);

    const updated = await this.stock.updateSettings(this.db, variantId, warehouseId, expectedVersion, patch);
    if (updated) return updated;
    const exists = await this.stock.find(this.db, variantId, warehouseId);
    if (!exists) throw new StockLevelNotFoundError(variantId, warehouseId);
    throw new StaleStockVersionError(variantId, warehouseId, expectedVersion);
  }

  /**
   * Ajuste manual (requiere permiso inventory.adjust en la API). En una transacción:
   * bloquea la fila, calcula el delta, actualiza on_hand, escribe el ledger y, si el
   * disponible cruza el punto de reorden, encola StockBelowThreshold en el outbox.
   */
  async adjust(tenantId: string, userId: string, input: AdjustStockInput): Promise<AdjustStockResult> {
    const reason = input.reason?.trim();
    if (!reason) throw new InvalidAdjustmentError('El motivo del ajuste es obligatorio');
    await this.variants.assertOfTenant(tenantId, [input.variantId]);

    return this.db.withTransaction(async (tx) => {
      const active = await this.warehouses.findActiveIds(tx, tenantId, [input.warehouseId]);
      if (!active.has(input.warehouseId)) throw new WarehouseInactiveError([input.warehouseId]);

      const current = await this.stock.lock(tx, input.variantId, input.warehouseId);
      const { delta } = planAdjustment(current, input);
      const level = await this.stock.applyOnHandDelta(tx, input.variantId, input.warehouseId, delta);

      await this.stock.insertMovements(tx, [
        {
          variantId: input.variantId,
          warehouseId: input.warehouseId,
          quantity: delta,
          movementType: input.type,
          referenceType: 'manual_adjustment',
          referenceId: null,
          unitCost: null,
          reason,
          userId,
        },
      ]);

      const availableBefore = current?.available ?? 0;
      if (crossedBelowThreshold(availableBefore, level.available, level.reorderPoint)) {
        await this.outbox.append(tx, [
          stockBelowThreshold(tenantId, {
            variantId: level.variantId,
            warehouseId: level.warehouseId,
            available: level.available,
            reorderPoint: level.reorderPoint,
            reorderQty: level.reorderQty,
            cause: 'adjustment',
          }),
        ]);
      }
      return { level, delta };
    });
  }

  listMovements(tenantId: string, filter: MovementFilter): Promise<StockMovement[]> {
    return this.stock.listMovements(this.db, tenantId, { ...filter, limit: Math.min(Math.max(filter.limit, 1), 200) });
  }

  /** Checkout: de qué bodega sale cada línea (lectura; la reserva atómica la valida después). */
  async planAllocation(tenantId: string, items: AllocationItem[], warehouseId?: string | null): Promise<ReservationLine[]> {
    const variantIds = [...new Set(items.map((i) => i.variantId))];
    const stock = await this.stock.availabilityByWarehouse(this.db, tenantId, variantIds, warehouseId);
    return planAllocation(items, stock, { warehouseId });
  }

  getAvailability(tenantId: string, variantIds: string[]): Promise<Map<string, number>> {
    return this.stock.availabilityByVariant(this.db, tenantId, [...new Set(variantIds)]);
  }

  private async assertWarehouseOfTenant(q: Queryable, tenantId: string, warehouseId: string): Promise<void> {
    if (!(await this.warehouses.findById(q, tenantId, warehouseId))) throw new WarehouseNotFoundError(warehouseId);
  }
}
