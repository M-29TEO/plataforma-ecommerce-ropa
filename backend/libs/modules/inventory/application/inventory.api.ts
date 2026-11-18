import { Injectable } from '@nestjs/common';
import { AllocationItem } from '../domain/allocation';
import { Reservation, ReservationLine } from '../domain/reservation';
import { GeoPoint, Warehouse } from '../domain/warehouse';
import { ReservationService, ReserveStockInput, ReserveStockResult } from './reservation.service';
import { ExchangeIssueInput, RestockReturnInput, ReturnStockService } from './return-stock.service';
import { StockService } from './stock.service';
import { WarehouseService } from './warehouse.service';

/** Lo que Logística necesita de una bodega para cotizar y despachar un envío. */
export interface ShippingWarehouse {
  id: string;
  code: string;
  name: string;
  city: string;
  /** address.province, si la dirección la trae. */
  province: string | null;
  address: Record<string, unknown>;
  location: GeoPoint;
}

/**
 * Fachada síncrona para otros módulos (Carrito/Checkout, Pedidos). Es lo único que
 * expone index.ts junto con los tipos: nadie fuera de Inventario conoce repositorios ni SQL.
 */
@Injectable()
export class InventoryApi {
  constructor(
    private readonly reservations: ReservationService,
    private readonly stock: StockService,
    private readonly warehouses: WarehouseService,
    private readonly returnStock: ReturnStockService,
  ) {}

  /** Checkout: reserva todo o nada. Lanza InsufficientStockError si alguna línea no alcanza. */
  reserveStock(input: ReserveStockInput): Promise<ReserveStockResult> {
    return this.reservations.reserve(input);
  }

  /** Pedido pagado: convierte la reserva en salida física (movimiento 'sale'). */
  confirmReservation(tenantId: string, orderId: string): Promise<Reservation[]> {
    return this.reservations.confirm(tenantId, orderId);
  }

  /** Pedido cancelado o pago fallido. Idempotente. */
  releaseReservation(tenantId: string, orderId: string): Promise<{ released: number }> {
    return this.reservations.release(tenantId, orderId);
  }

  /**
   * Checkout: reparte las líneas del pedido entre bodegas (una sola si alcanza; con warehouseId,
   * esa tienda). Lanza AllocationShortageError (409 INSUFFICIENT_STOCK) si no hay stock.
   */
  planAllocation(tenantId: string, items: AllocationItem[], warehouseId?: string | null): Promise<ReservationLine[]> {
    return this.stock.planAllocation(tenantId, items, warehouseId);
  }

  /** Logística: bodegas activas que despachan online (origen de la distancia y de los couriers). */
  async listShippingWarehouses(tenantId: string): Promise<ShippingWarehouse[]> {
    const list = await this.warehouses.list(tenantId, { active: true });
    return list.filter((w) => w.shipsOnline).map(toShippingWarehouse);
  }

  /** Cualquier bodega o tienda activa del tenant (una tienda de retiro recibe devoluciones aunque no despache online). */
  async getActiveWarehouse(tenantId: string, warehouseId: string): Promise<ShippingWarehouse | null> {
    const list = await this.warehouses.list(tenantId, { active: true });
    const found = list.find((w) => w.id === warehouseId);
    return found ? toShippingWarehouse(found) : null;
  }

  /** Devolución inspeccionada: reingresa las unidades en buen estado (movimiento 'return'). Idempotente por devolución. */
  restockReturn(input: RestockReturnInput): Promise<{ restocked: number; alreadyApplied: boolean }> {
    return this.returnStock.restock(input);
  }

  /**
   * Cambio de talla: descuenta la variante nueva (movimiento 'sale') y dice de qué bodega sale.
   * Idempotente por devolución. Lanza AllocationShortageError / InsufficientStockError sin stock.
   */
  issueForExchange(input: ExchangeIssueInput): Promise<ReservationLine[]> {
    return this.returnStock.issueForExchange(input);
  }

  /** Disponible total por variante (bodegas activas que despachan online). */
  getAvailability(tenantId: string, variantIds: string[]): Promise<Map<string, number>> {
    return this.stock.getAvailability(tenantId, variantIds);
  }
}

function toShippingWarehouse(w: Warehouse): ShippingWarehouse {
  return {
    id: w.id,
    code: w.code,
    name: w.name,
    city: w.city,
    province: typeof w.address.province === 'string' && w.address.province.trim() ? w.address.province.trim() : null,
    address: w.address,
    location: w.location,
  };
}
