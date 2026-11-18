import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConflictError, Database, OutboxWriter, RealtimePublisher, ValidationError } from '../../../shared-kernel';
import { InventoryApi } from '../../inventory';
import { shipmentStatusChanged } from '../domain/events';
import { assertShipmentTransition, orderRoom, REALTIME_EVENTS, ridersRoom, STAFF_EVENTS, STAFF_NAMESPACE, STATUS_DESCRIPTIONS } from '../domain/tracking';
import { HandoffRepository, OutboundShipmentInfo } from './handoff-ports';
import { TrackingRepository } from './tracking-ports';

export interface ReadyForPickupInput {
  tenantId: string;
  orderId: string;
  fulfillmentType: 'rider' | 'courier' | 'pickup';
  /** sales.orders.source_warehouse_id: bodega que despacha o tienda de retiro. */
  warehouseId: string | null;
  /** Contra entrega en retiro en tienda: lo que se cobra en mostrador ('0.00' si ya está pagado). */
  codAmount: string;
}

export interface HandoffResult {
  shipmentId: string;
  carrierType: string;
  status: string;
  /** false si el envío ya estaba listo (reintento) o más adelante (motorizado ya asignado). */
  changed: boolean;
}

const PICKUP_READY_DESCRIPTION = 'Tu pedido está listo para retirar en tienda';

/**
 * La bodega terminó el picking: el envío de despacho del pedido pasa de 'pending' a 'ready_for_pickup'
 * (el motorizado o el courier ya puede retirarlo). En retiro en tienda el checkout no crea envío: se
 * crea aquí, ya listo para retirar, con la tienda como destino. Emite ShipmentStatusChanged por el
 * outbox en la misma transacción y avisa a la sala del pedido después del commit.
 */
@Injectable()
export class HandoffService {
  constructor(
    private readonly db: Database,
    private readonly handoff: HandoffRepository,
    private readonly tracking: TrackingRepository,
    private readonly inventory: InventoryApi,
    private readonly outbox: OutboxWriter,
    private readonly realtime: RealtimePublisher,
  ) {}

  /** Envío de despacho vigente de cada pedido (con su franja), para la cola de picking. */
  async outboundByOrder(tenantId: string, orderIds: string[]): Promise<Map<string, OutboundShipmentInfo>> {
    const rows = await this.handoff.listOutbound(this.db, tenantId, [...new Set(orderIds)]);
    return new Map(rows.map((r) => [r.orderId, r]));
  }

  /** Idempotente: un envío ya listo (o más adelante) se devuelve sin cambios. */
  async markReadyForPickup(input: ReadyForPickupInput, now = new Date()): Promise<HandoffResult> {
    const { result, broadcast } = await this.db.withTransaction(async (tx) => {
      await this.handoff.lockOrder(tx, input.orderId);
      const [current] = await this.handoff.listOutbound(tx, input.tenantId, [input.orderId]);

      if (current) {
        const s = await this.tracking.findById(tx, input.tenantId, current.shipmentId, { lock: true });
        if (!s || s.status !== 'pending') {
          return { result: { shipmentId: current.shipmentId, carrierType: current.carrierType, status: s?.status ?? current.status, changed: false }, broadcast: null };
        }
        assertShipmentTransition(s.status, 'ready_for_pickup');
        const description = STATUS_DESCRIPTIONS.ready_for_pickup;
        await this.tracking.updateStatus(tx, s.id, { status: 'ready_for_pickup' });
        await this.tracking.insertEvent(tx, s.id, 'ready_for_pickup', description, 'staff', now);
        await this.outbox.append(tx, [
          shipmentStatusChanged(input.tenantId, {
            shipmentId: s.id,
            orderId: s.orderId,
            returnId: null,
            direction: 'outbound',
            carrierType: s.carrierType,
            previousStatus: s.status,
            status: 'ready_for_pickup',
            trackingToken: s.trackingToken,
            description,
            occurredAt: now.toISOString(),
          }),
        ]);
        return { result: { shipmentId: s.id, carrierType: s.carrierType, status: 'ready_for_pickup', changed: true }, broadcast: { shipmentId: s.id, description } };
      }

      if (input.fulfillmentType !== 'pickup') {
        throw new ConflictError('SHIPMENT_MISSING', 'El pedido no tiene un envío de despacho vigente', { orderId: input.orderId });
      }
      const store = input.warehouseId ? await this.inventory.getActiveWarehouse(input.tenantId, input.warehouseId) : null;
      if (!store) {
        throw new ValidationError('PICKUP_STORE_UNAVAILABLE', 'La tienda de retiro del pedido no existe o está inactiva', { warehouseId: input.warehouseId });
      }
      const trackingToken = randomBytes(18).toString('base64url');
      const shipmentId = await this.handoff.insertPickupReady(tx, {
        tenantId: input.tenantId,
        orderId: input.orderId,
        trackingToken,
        warehouseId: store.id,
        destination: { ...store.address, storeName: store.name, city: store.city },
        location: store.location,
        codAmount: input.codAmount,
        description: PICKUP_READY_DESCRIPTION,
      });
      await this.outbox.append(tx, [
        shipmentStatusChanged(input.tenantId, {
          shipmentId,
          orderId: input.orderId,
          returnId: null,
          direction: 'outbound',
          carrierType: 'pickup',
          previousStatus: 'pending',
          status: 'ready_for_pickup',
          trackingToken,
          description: PICKUP_READY_DESCRIPTION,
          occurredAt: now.toISOString(),
        }),
      ]);
      return { result: { shipmentId, carrierType: 'pickup', status: 'ready_for_pickup', changed: true }, broadcast: { shipmentId, description: PICKUP_READY_DESCRIPTION } };
    });

    if (broadcast) {
      this.realtime.publish(orderRoom(input.orderId), REALTIME_EVENTS.status, {
        shipmentId: broadcast.shipmentId,
        status: 'ready_for_pickup',
        description: broadcast.description,
        occurredAt: now.toISOString(),
      });
      // Cola de despacho del backoffice (namespace /staff): el envío ya se puede asignar.
      this.realtime.publish(
        ridersRoom(input.tenantId),
        STAFF_EVENTS.status,
        { shipmentId: broadcast.shipmentId, orderId: input.orderId, riderId: null, status: 'ready_for_pickup' },
        STAFF_NAMESPACE,
      );
    }
    return result;
  }
}
