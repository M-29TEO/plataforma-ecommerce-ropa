import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Database, NotFoundError, OutboxWriter, ValidationError } from '../../../shared-kernel';
import { InventoryApi, ShippingWarehouse } from '../../inventory';
import { shipmentStatusChanged } from '../domain/events';
import { GeoPoint } from '../domain/geo';
import { provinceFor } from '../domain/places';
import { NewReverseShipment, ShipmentRepository, ShipmentSummary } from './ports';

export interface ReverseShipmentItem {
  orderItemId: string;
  quantity: number;
}

export interface ReturnPickupInput {
  tenantId: string;
  orderId: string;
  returnId: string;
  rmaNumber: string;
  /** Cómo se entregó el pedido: el retiro usa el mismo medio (retiro en tienda → el cliente lo lleva). */
  fulfillmentType: 'rider' | 'courier' | 'pickup';
  /** Dirección de entrega del pedido (donde se recoge). null en retiro en tienda. */
  address: Record<string, unknown> | null;
  location: GeoPoint | null;
  city: string | null;
  /** Bodega que recibe: la de origen del pedido; si falta, la primera que despacha online. */
  warehouseId: string | null;
  weightG: number;
  items: ReverseShipmentItem[];
}

export interface ExchangeShipmentInput {
  tenantId: string;
  orderId: string;
  returnId: string;
  rmaNumber: string;
  fulfillmentType: 'rider' | 'courier' | 'pickup';
  address: Record<string, unknown> | null;
  location: GeoPoint | null;
  city: string | null;
  /** Bodega de la que sale la talla nueva (la que eligió Inventario). */
  warehouseId: string;
  weightG: number;
  items: ReverseShipmentItem[];
}

export interface ReverseShipmentResult {
  shipment: ShipmentSummary;
  /** false si ya existía (reintento): idempotente por devolución y dirección. */
  created: boolean;
}

/** Peso mínimo de un paquete (una prenda doblada con su bolsa). */
const MIN_WEIGHT_G = 100;

/**
 * Logística inversa: el retiro de una devolución (direction 'return') y el envío de la talla
 * nueva de un cambio (direction 'exchange'). Los envíos nacen 'pending', como los del checkout;
 * el despacho (asignación de motorizado o guía de courier) es el mismo flujo que el de un pedido.
 * Todo corre dentro de la transacción del orquestador de posventa.
 */
@Injectable()
export class ReverseLogisticsService {
  constructor(
    private readonly db: Database,
    private readonly shipments: ShipmentRepository,
    private readonly inventory: InventoryApi,
    private readonly outbox: OutboxWriter,
  ) {}

  async scheduleReturnPickup(input: ReturnPickupInput): Promise<ReverseShipmentResult> {
    const warehouse = await this.warehouse(input.tenantId, input.warehouseId);
    const dropOff = input.fulfillmentType === 'pickup';
    return this.insert({
      tenantId: input.tenantId,
      orderId: input.orderId,
      returnId: input.returnId,
      direction: 'return',
      carrierType: input.fulfillmentType,
      trackingToken: randomBytes(18).toString('base64url'),
      originWarehouseId: warehouse.id,
      // Retiro en tienda: no hay a dónde ir; el cliente entrega el paquete en la tienda.
      destination: dropOff ? this.storeDestination(warehouse, 'drop_off') : this.customerDestination(input, 'pickup'),
      destinationLocation: dropOff ? warehouse.location : input.location,
      weightG: Math.max(MIN_WEIGHT_G, Math.round(input.weightG)),
      items: input.items,
      description: dropOff
        ? `Devolución ${input.rmaNumber}: el cliente entrega el paquete en ${warehouse.name}`
        : `Retiro de la devolución ${input.rmaNumber} en la dirección del cliente`,
    });
  }

  /** El paquete llegó a bodega (warehouseId: la que lo recibió, si no es la prevista). */
  async markReturnReceived(tenantId: string, returnId: string, warehouseId: string | null): Promise<ShipmentSummary> {
    if (warehouseId) await this.warehouse(tenantId, warehouseId);
    return this.db.withTransaction(async (tx) => {
      const before = await this.shipments.findByReturn(tx, tenantId, returnId, 'return');
      const shipment = await this.shipments.markReturnDelivered(tx, tenantId, returnId, warehouseId);
      if (!shipment) throw new NotFoundError('RETURN_SHIPMENT_NOT_FOUND', 'La devolución no tiene envío de retiro', { returnId });
      // Solo si de verdad cambió (un reintento sobre un retiro ya entregado no emite nada).
      if (before && before.status !== 'delivered' && shipment.status === 'delivered') {
        await this.outbox.append(tx, [
          shipmentStatusChanged(tenantId, {
            shipmentId: shipment.id,
            orderId: shipment.orderId,
            returnId,
            direction: 'return',
            carrierType: shipment.carrierType,
            previousStatus: before.status,
            status: 'delivered',
            trackingToken: shipment.trackingToken,
            description: 'Devolución recibida en bodega',
            occurredAt: (shipment.deliveredAt ?? new Date()).toISOString(),
          }),
        ]);
      }
      return shipment;
    });
  }

  async createExchangeShipment(input: ExchangeShipmentInput): Promise<ReverseShipmentResult> {
    const warehouse = await this.warehouse(input.tenantId, input.warehouseId);
    const pickup = input.fulfillmentType === 'pickup';
    return this.insert({
      tenantId: input.tenantId,
      orderId: input.orderId,
      returnId: input.returnId,
      direction: 'exchange',
      carrierType: input.fulfillmentType,
      trackingToken: randomBytes(18).toString('base64url'),
      originWarehouseId: warehouse.id,
      destination: pickup ? this.storeDestination(warehouse, 'store_pickup') : this.customerDestination(input, 'delivery'),
      destinationLocation: pickup ? warehouse.location : input.location,
      weightG: Math.max(MIN_WEIGHT_G, Math.round(input.weightG)),
      items: input.items,
      description: `Envío de la talla nueva del cambio ${input.rmaNumber}`,
    });
  }

  getReturnShipment(tenantId: string, returnId: string, direction: 'return' | 'exchange' = 'return'): Promise<ShipmentSummary | null> {
    return this.shipments.findByReturn(this.db, tenantId, returnId, direction);
  }

  private insert(s: NewReverseShipment): Promise<ReverseShipmentResult> {
    if (!s.items.length) throw new ValidationError('EMPTY_SHIPMENT', 'El envío no tiene ítems');
    return this.db.withTransaction(async (tx) => {
      // Savepoint: si otro proceso creó el envío primero, el unique violation no aborta la transacción de afuera.
      const id = await this.db.withTransaction((sp) => this.shipments.insertReverse(sp, s));
      const shipment = await this.shipments.findByReturn(tx, s.tenantId, s.returnId, s.direction);
      if (!shipment) throw new Error(`No se encontró el envío ${s.direction} de la devolución ${s.returnId}`);
      return { shipment, created: id !== null };
    });
  }

  /** Bodega o tienda activa indicada; sin id, la primera bodega que despacha en línea. */
  private async warehouse(tenantId: string, warehouseId: string | null): Promise<ShippingWarehouse> {
    const found = warehouseId
      ? await this.inventory.getActiveWarehouse(tenantId, warehouseId)
      : ((await this.inventory.listShippingWarehouses(tenantId))[0] ?? null);
    if (!found) throw new ValidationError('WAREHOUSE_NOT_AVAILABLE', 'La bodega no existe o no está activa', { warehouseId });
    return found;
  }

  private customerDestination(
    input: { address: Record<string, unknown> | null; city: string | null },
    type: 'pickup' | 'delivery',
  ): Record<string, unknown> {
    const address = input.address ?? {};
    const city = input.city ?? (typeof address.city === 'string' ? address.city : null);
    const province = typeof address.province === 'string' ? address.province : null;
    return { ...address, type, city, province: city ? provinceFor(city, province) : province };
  }

  private storeDestination(w: ShippingWarehouse, type: 'drop_off' | 'store_pickup'): Record<string, unknown> {
    return { ...w.address, type, warehouseId: w.id, name: w.name, city: w.city, province: w.province };
  }
}
