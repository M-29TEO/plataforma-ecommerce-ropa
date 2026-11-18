import { Injectable } from '@nestjs/common';
import { ConflictError } from '../../../shared-kernel';
import { CatalogApi } from '../../catalog';
import { LogisticsApi } from '../../logistics';
import { Actor, OrderDetail, OrdersApi } from '../../orders';
import { assertPickComplete, compareQueue, PickedLine, PickState } from '../domain/picking';

/** Cuántos pedidos se leen para armar la cola (se ordena por franja en memoria, que vive en Logística). */
const QUEUE_SCAN_LIMIT = 1000;

export interface QueueFilter {
  warehouseId?: string;
  state: PickState;
  limit: number;
  offset: number;
}

/**
 * Orquestador del picking de bodega (sin schema propio). Pedidos dice qué está listo para preparar
 * (máquina de estados) y lo pasa a preparing; Catálogo aporta el código de barras y la imagen de cada
 * variante; Logística deja el envío listo para retiro al terminar. Nadie importa este módulo.
 */
@Injectable()
export class PickingService {
  constructor(
    private readonly orders: OrdersApi,
    private readonly catalog: CatalogApi,
    private readonly logistics: LogisticsApi,
  ) {}

  async queue(tenantId: string, f: QueueFilter) {
    const candidates = await this.orders.listFulfillmentQueue(tenantId, { stage: f.state, warehouseId: f.warehouseId, limit: QUEUE_SCAN_LIMIT });
    const shipments = await this.logistics.getOutboundShipments(tenantId, candidates.map((o) => o.id));
    // En preparación pero con el envío ya listo (o un motorizado asignado): ya salió de la mesa de picking.
    const pending = f.state === 'picking' ? candidates.filter((o) => (shipments.get(o.id)?.status ?? 'pending') === 'pending') : candidates;
    const rows = pending
      .map((o) => ({ o, slot: shipments.get(o.id)?.slot ?? null }))
      .sort((a, b) =>
        compareQueue(
          { slotStartsAt: a.slot?.startsAt ?? null, placedAt: a.o.placedAt, orderNumber: a.o.orderNumber },
          { slotStartsAt: b.slot?.startsAt ?? null, placedAt: b.o.placedAt, orderNumber: b.o.orderNumber },
        ),
      );
    return {
      items: rows.slice(f.offset, f.offset + f.limit).map(({ o, slot }) => ({
        orderId: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        placedAt: o.placedAt,
        fulfillmentType: o.fulfillmentType,
        paymentMethod: o.paymentMethod,
        warehouseId: o.sourceWarehouseId,
        deliverySlot: slot ? { startsAt: slot.startsAt, endsAt: slot.endsAt } : null,
        itemCount: o.itemCount,
        unitCount: o.unitCount,
        customerName: o.customer.name,
      })),
      total: rows.length,
    };
  }

  async detail(tenantId: string, orderId: string) {
    const order = await this.orders.getOrder(tenantId, orderId);
    const [labels, shipments] = await Promise.all([
      this.catalog.getVariantLabels(tenantId, order.items.map((i) => i.variantId)),
      this.logistics.getOutboundShipments(tenantId, [orderId]),
    ]);
    const shipment = shipments.get(orderId) ?? null;
    return {
      ...this.header(order),
      notes: order.notes,
      deliverySlot: shipment?.slot ?? null,
      shipmentStatus: shipment?.status ?? null,
      items: order.items.map((i) => {
        const label = labels.get(i.variantId);
        return {
          orderItemId: i.id,
          variantId: i.variantId,
          sku: i.sku,
          barcode: label?.barcode ?? null,
          productName: i.productName,
          color: i.colorName,
          size: i.sizeCode,
          quantity: i.quantity - i.qtyReturned,
          imageUrl: label?.imageUrl ?? null,
        };
      }),
    };
  }

  /** Pasa el pedido a preparing. Idempotente: si ya está en preparación lo devuelve tal cual. */
  async start(tenantId: string, orderId: string, version: number, actor: Actor) {
    const order = await this.orders.getOrder(tenantId, orderId);
    if (order.status === 'preparing') return this.header(order);
    const updated = await this.orders.changeStatusAtVersion(tenantId, orderId, 'preparing', version, actor);
    return this.header(updated);
  }

  /**
   * Cierra el picking: exige exactamente las unidades pedidas (422 PICK_INCOMPLETE / PICK_EXCESS) y
   * deja el envío listo para retiro en Logística. Reintentar después de cerrar responde lo mismo.
   */
  async complete(tenantId: string, orderId: string, picked: PickedLine[]) {
    const order = await this.orders.getOrder(tenantId, orderId);
    if (order.status !== 'preparing') {
      throw new ConflictError('PICK_NOT_STARTED', `El pedido está ${order.status}: el picking se cierra en preparación`, { status: order.status });
    }
    assertPickComplete(
      order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity - i.qtyReturned })),
      picked,
    );
    const shipment = await this.logistics.markReadyForPickup({
      tenantId,
      orderId,
      fulfillmentType: order.fulfillmentType,
      warehouseId: order.sourceWarehouseId,
      // Retiro en tienda contra entrega: se cobra en mostrador.
      codAmount: order.paymentMethod === 'cod' && order.paymentStatus !== 'paid' ? order.total : '0.00',
    });
    return {
      ...this.header(order),
      shipment: { id: shipment.shipmentId, carrierType: shipment.carrierType, status: shipment.status },
    };
  }

  private header(o: Pick<OrderDetail, 'id' | 'orderNumber' | 'status' | 'version' | 'fulfillmentType' | 'sourceWarehouseId'>) {
    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      version: o.version,
      fulfillmentType: o.fulfillmentType,
      warehouseId: o.sourceWarehouseId,
    };
  }
}
