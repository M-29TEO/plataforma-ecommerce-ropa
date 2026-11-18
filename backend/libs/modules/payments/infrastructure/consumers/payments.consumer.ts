import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventBus } from '../../../../shared-kernel';
import { ORDER_CANCELLED, ORDER_DELIVERED } from '../../../orders/events';
import type { OrderCancelledPayload, OrderDeliveredPayload } from '../../../orders/events';
import { PaymentService } from '../../application/payment.service';

/**
 * Pagos reacciona a Pedidos:
 *  - OrderCancelled → los pagos abiertos del pedido pasan a cancelled (una aprobación tardía de la
 *    pasarela ya no lo captura; queda como late_approval para reembolso).
 *  - OrderDelivered (contra entrega) → se captura el pago COD: el motorizado cobró.
 * Ambos son idempotentes.
 */
@Injectable()
export class PaymentsConsumer implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly payments: PaymentService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<OrderCancelledPayload>(ORDER_CANCELLED, 'payments', async (e) => {
      await this.payments.cancelOpenForOrder(e.tenantId, e.payload.orderId, `Pedido cancelado: ${e.payload.reason}`);
    });
    this.bus.subscribe<OrderDeliveredPayload>(ORDER_DELIVERED, 'payments', async (e) => {
      if (e.payload.paymentMethod !== 'cod') return;
      await this.payments.captureCashOnDelivery(e.tenantId, e.payload.orderId);
    });
  }
}
