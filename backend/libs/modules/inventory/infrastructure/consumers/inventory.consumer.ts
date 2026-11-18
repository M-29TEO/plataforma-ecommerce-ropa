import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBus } from '../../../../shared-kernel';
import { ORDER_CANCELLED, ORDER_PAID, ORDER_PLACED } from '../../../orders';
import type { OrderCancelledPayload, OrderPaidPayload, OrderPlacedPayload } from '../../../orders';
import { ReservationService } from '../../application/reservation.service';
import { ReservationExpiredError, ReservationNotFoundError } from '../../domain/errors';

/**
 * Inventario reacciona a Pedidos (idempotente):
 *  - OrderPlaced contra entrega → confirma la reserva (el pedido pasa a preparación sin pago).
 *  - OrderPaid → confirma la reserva (salida física, movimiento 'sale'). En COD, OrderPaid llega
 *    al entregar y la reserva ya se consumió: no hay nada que hacer.
 *  - OrderCancelled → libera la reserva activa (pago rechazado o vencido, cancelación del cliente).
 */
@Injectable()
export class InventoryConsumer implements OnModuleInit {
  private readonly logger = new Logger(InventoryConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly reservations: ReservationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<OrderPlacedPayload>(ORDER_PLACED, 'inventory', async (e) => {
      if (e.payload.paymentMethod === 'cod') await this.confirm(e.tenantId, e.payload.orderId);
    });
    this.bus.subscribe<OrderPaidPayload>(ORDER_PAID, 'inventory', async (e) => {
      await this.confirm(e.tenantId, e.payload.orderId);
    });
    this.bus.subscribe<OrderCancelledPayload>(ORDER_CANCELLED, 'inventory', async (e) => {
      const { released } = await this.reservations.release(e.tenantId, e.payload.orderId);
      if (released === 0 && ['paid', 'preparing'].includes(e.payload.previousStatus)) {
        // La reserva ya se había consumido: hace falta reponer on_hand (pendiente en InventoryApi).
        this.logger.warn(`Pedido ${e.payload.orderId} cancelado con la reserva ya consumida: reponer stock manualmente`);
      }
    });
  }

  private async confirm(tenantId: string, orderId: string): Promise<void> {
    try {
      await this.reservations.confirm(tenantId, orderId);
    } catch (error) {
      // Sin reserva activa: ya se confirmó (evento repetido o COD entregado) o se liberó.
      if (error instanceof ReservationNotFoundError) return;
      if (error instanceof ReservationExpiredError) {
        this.logger.warn(`La reserva del pedido ${orderId} venció antes de confirmarse: revisar stock`);
        return;
      }
      throw error;
    }
  }
}
