import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventBus } from '../../../../shared-kernel';
import { ORDER_CANCELLED } from '../../../orders';
import type { OrderCancelledPayload } from '../../../orders';
import { DeliveryQuoteService } from '../../application/delivery-quote.service';
import { DispatchService } from '../../application/dispatch.service';
import { SHIPMENT_STATUS_CHANGED, ShipmentStatusChangedPayload } from '../../domain/events';

/**
 * Logística reacciona a eventos (idempotente):
 *  - OrderCancelled → cancela los envíos 'pending' del pedido y devuelve el cupo de su franja
 *    (pago rechazado o vencido, cancelación del cliente). Un envío ya despachado no se toca.
 *  - ShipmentStatusChanged a 'ready_for_pickup' de un despacho con motorizado (la bodega terminó el
 *    picking) → despacho automático: se ofrece al mejor motorizado. Si ya tiene una oferta abierta,
 *    no se crea otra; si nadie está disponible, el job lo reintenta y si no, queda para el backoffice.
 */
@Injectable()
export class LogisticsConsumer implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly deliveries: DeliveryQuoteService,
    private readonly dispatch: DispatchService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<OrderCancelledPayload>(ORDER_CANCELLED, 'logistics', async (e) => {
      await this.deliveries.cancelForOrder(e.tenantId, e.payload.orderId, `Pedido cancelado: ${e.payload.reason}`);
    });
    this.bus.subscribe<ShipmentStatusChangedPayload>(SHIPMENT_STATUS_CHANGED, 'logistics.dispatch', async (e) => {
      const p = e.payload;
      if (p.status !== 'ready_for_pickup' || p.carrierType !== 'rider' || p.direction !== 'outbound') return;
      await this.dispatch.dispatch(e.tenantId, p.shipmentId);
    });
  }
}
