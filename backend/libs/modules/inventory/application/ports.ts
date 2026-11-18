/**
 * Puertos de persistencia del módulo Inventario.
 *
 * Son clases abstractas (no interfaces) para usarlas directamente como tokens de inyección
 * de Nest. La capa de aplicación depende de estos contratos; infrastructure/ los implementa
 * con SQL sobre el schema inventory. Todos los métodos reciben el Queryable de la
 * transacción en curso para que el caso de uso sea atómico.
 */
import { Queryable } from '../../../shared-kernel';
import { WarehouseAvailability } from '../domain/allocation';
import { PurchaseOrder,PurchaseOrderStatus } from '../domain/purchase-order';
import { Reservation, ReservationLine, ReservationStatus } from '../domain/reservation';
import { NewStockMovement, StockLevel, StockMovement } from '../domain/stock';
import { Supplier } from '../domain/supplier';
import { GeoPoint, Warehouse, WarehouseType } from '../domain/warehouse';

// ---------------------------------------------------------------- Bodegas
export type NewWarehouse = Omit<Warehouse, 'id'>;
export type WarehousePatch = Partial<Omit<Warehouse, 'id' | 'tenantId' | 'code'>>;

export interface WarehouseFilter {
  active?: boolean;
  city?: string;
  type?: WarehouseType;
}

export abstract class WarehouseRepository {
  abstract insert(q: Queryable, w: NewWarehouse): Promise<Warehouse>;
  abstract findById(q: Queryable, tenantId: string, id: string): Promise<Warehouse | null>;
  abstract list(q: Queryable, tenantId: string, filter: WarehouseFilter): Promise<Warehouse[]>;
  abstract update(q: Queryable, tenantId: string, id: string, patch: WarehousePatch): Promise<Warehouse | null>;
  abstract findNearby(
    q: Queryable,
    tenantId: string,
    point: GeoPoint,
    radiusMeters: number,
    limit: number,
  ): Promise<(Warehouse & { distanceMeters: number })[]>;
  /** Devuelve cuáles de los ids son bodegas activas del tenant. */
  abstract findActiveIds(q: Queryable, tenantId: string, ids: string[]): Promise<Set<string>>;
}

// ---------------------------------------------------------------- Stock
export interface ReserveResult {
  available: number;
  reorderPoint: number;
  reorderQty: number;
}

export interface StockSettingsPatch {
  reorderPoint?: number;
  reorderQty?: number;
  binLocation?: string | null;
}

export interface MovementFilter {
  variantId?: string;
  warehouseId?: string;
  limit: number;
  beforeId?: string;
}

export abstract class StockRepository {
  abstract find(q: Queryable, variantId: string, warehouseId: string): Promise<StockLevel | null>;
  abstract listByWarehouse(
    q: Queryable,
    warehouseId: string,
    opts: { belowReorderPoint?: boolean; limit: number; offset: number },
  ): Promise<StockLevel[]>;
  abstract listByVariant(q: Queryable, tenantId: string, variantId: string): Promise<StockLevel[]>;
  /** SELECT ... FOR UPDATE. */
  abstract lock(q: Queryable, variantId: string, warehouseId: string): Promise<StockLevel | null>;

  /** UPDATE condicional atómico. null = sin stock suficiente (0 filas afectadas). */
  abstract tryReserve(q: Queryable, line: ReservationLine): Promise<ReserveResult | null>;
  abstract releaseReserved(q: Queryable, line: ReservationLine): Promise<void>;
  /** Venta confirmada: baja on_hand y reserved a la vez (available no cambia). */
  abstract consumeReserved(q: Queryable, line: ReservationLine): Promise<void>;
  /** Suma (o resta) a on_hand; crea la fila si no existe. */
  abstract applyOnHandDelta(q: Queryable, variantId: string, warehouseId: string, delta: number): Promise<StockLevel>;
  /** Concurrencia optimista por version. null = versión desactualizada o fila inexistente. */
  abstract updateSettings(
    q: Queryable,
    variantId: string,
    warehouseId: string,
    expectedVersion: number,
    patch: StockSettingsPatch,
  ): Promise<StockLevel | null>;

  abstract insertMovements(q: Queryable, movements: NewStockMovement[]): Promise<void>;
  abstract listMovements(q: Queryable, tenantId: string, filter: MovementFilter): Promise<StockMovement[]>;
  /** Movimientos de un documento (ix_movements_ref): idempotencia de devoluciones y cambios. */
  abstract findMovementsByReference(q: Queryable, referenceType: string, referenceId: string): Promise<StockMovement[]>;
  /** Disponible total por variante en bodegas activas que despachan online. */
  abstract availabilityByVariant(q: Queryable, tenantId: string, variantIds: string[]): Promise<Map<string, number>>;
  /**
   * Disponible por variante y bodega. Sin warehouseId: bodegas activas que despachan online;
   * con warehouseId: solo esa bodega si está activa (retiro en tienda).
   */
  abstract availabilityByWarehouse(
    q: Queryable,
    tenantId: string,
    variantIds: string[],
    warehouseId?: string | null,
  ): Promise<WarehouseAvailability[]>;
}

// ---------------------------------------------------------------- Reservas
export abstract class ReservationRepository {
  /** Serializa operaciones sobre el mismo pedido (pg_advisory_xact_lock). */
  abstract lockOrder(q: Queryable, orderId: string): Promise<void>;
  /** expires_at = now() + ttl con el reloj de PostgreSQL (el mismo que usa el job de vencimiento). */
  abstract insertMany(
    q: Queryable,
    orderId: string,
    lines: ReservationLine[],
    ttlSeconds: number,
  ): Promise<Reservation[]>;
  abstract findByOrder(q: Queryable, tenantId: string, orderId: string): Promise<Reservation[]>;
  /** Reservas activas del pedido con FOR UPDATE, ordenadas por (variant_id, warehouse_id). */
  abstract lockActiveByOrder(
    q: Queryable,
    tenantId: string,
    orderId: string,
  ): Promise<(Reservation & { isExpired: boolean })[]>;
  abstract setStatus(q: Queryable, ids: string[], status: ReservationStatus): Promise<void>;
  /**
   * Toma hasta `limit` reservas activas vencidas (FOR UPDATE SKIP LOCKED), las marca
   * 'released' y las devuelve. SKIP LOCKED permite varios workers sin doble liberación.
   */
  abstract claimExpired(q: Queryable, limit: number): Promise<Reservation[]>;
}

// ---------------------------------------------------------------- Proveedores
export type NewSupplier = Omit<Supplier, 'id'>;
export type SupplierPatch = Partial<Omit<Supplier, 'id' | 'tenantId'>>;

export abstract class SupplierRepository {
  abstract insert(q: Queryable, s: NewSupplier): Promise<Supplier>;
  abstract findById(q: Queryable, tenantId: string, id: string): Promise<Supplier | null>;
  abstract list(q: Queryable, tenantId: string, filter: { active?: boolean; search?: string }): Promise<Supplier[]>;
  abstract update(q: Queryable, tenantId: string, id: string, patch: SupplierPatch): Promise<Supplier | null>;
}

// ---------------------------------------------------------------- Órdenes de compra
export interface PurchaseOrderFilter {
  status?: PurchaseOrderStatus;
  supplierId?: string;
  warehouseId?: string;
  limit: number;
  offset: number;
}

export abstract class PurchaseOrderRepository {
  abstract insert(q: Queryable, po: PurchaseOrder): Promise<void>;
  abstract findById(
    q: Queryable,
    tenantId: string,
    id: string,
    opts?: { forUpdate?: boolean },
  ): Promise<PurchaseOrder | null>;
  abstract list(q: Queryable, tenantId: string, filter: PurchaseOrderFilter): Promise<PurchaseOrder[]>;
  /** Persiste estado y cantidades recibidas. */
  abstract save(q: Queryable, po: PurchaseOrder): Promise<void>;
}
