import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBus } from '../../../../shared-kernel';
import { PAYMENT_CAPTURED, PAYMENT_EXPIRED, PAYMENT_FAILED, REFUND_SUCCEEDED } from '../../../payments/events';
import type { PaymentCapturedPayload, PaymentExpiredPayload, PaymentFailedPayload, RefundSucceededPayload } from '../../../payments/events';
import { OrderService } from '../../application/order.service';
import { ReturnService } from '../../application/return.service';
import { Actor } from '../../domain/order';
import { InvalidOrderTransitionError } from '../../domain/errors';

const SYSTEM: Actor = { type: 'system', id: null };

/**
 * Pedidos reacciona a Pagos (entrega "al menos una vez": todo es idempotente):
 *  - PaymentCaptured → paid (markPaid no hace nada si ya estaba pagado).
 *  - PaymentFailed / PaymentExpired → cancelled, solo si el pedido sigue en created. El
 *    OrderCancelled resultante libera el stock (Inventario) y los cupos (Promociones).
 *  - RefundSucceeded → la devolución queda refunded y el pedido partially_refunded o refunded.
 */
@Injectable()
export class OrdersConsumer implements OnModuleInit {
  private readonly logger = new Logger(OrdersConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly orders: OrderService,
    private readonly returns: ReturnService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PaymentCapturedPayload>(PAYMENT_CAPTURED, 'orders', async (e) => {
      try {
        await this.orders.markPaid(e.tenantId, e.payload.orderId, SYSTEM);
      } catch (error) {
        // El pedido se canceló antes de que llegara la captura (p. ej. venció el pago): no hay
        // transición posible. Reintentar no lo arregla; requiere reembolso manual.
        if (!(error instanceof InvalidOrderTransitionError)) throw error;
        this.logger.warn(`Pago ${e.payload.paymentId} capturado para el pedido ${e.payload.orderId} que ya no admite pago: ${error.message}`);
      }
    });
    this.bus.subscribe<PaymentFailedPayload>(PAYMENT_FAILED, 'orders', async (e) => {
      const detail = e.payload.failureMessage ?? e.payload.failureCode;
      await this.orders.cancelUnpaid(e.tenantId, e.payload.orderId, `Pago rechazado: ${detail}`, SYSTEM);
    });
    this.bus.subscribe<PaymentExpiredPayload>(PAYMENT_EXPIRED, 'orders', async (e) => {
      await this.orders.cancelUnpaid(e.tenantId, e.payload.orderId, 'Pago no completado a tiempo', SYSTEM);
    });
    this.bus.subscribe<RefundSucceededPayload>(REFUND_SUCCEEDED, 'orders', async (e) => {
      await this.returns.recordRefund(e.tenantId, {
        orderId: e.payload.orderId,
        returnId: e.payload.returnId,
        orderRefundedTotal: e.payload.orderRefundedTotal,
      });
    });
  }
}
