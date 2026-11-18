import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventBus } from '../../../../shared-kernel';
import { ORDER_DELIVERED, RETURN_REFUNDED } from '../../../orders';
import type { OrderDeliveredPayload, ReturnEventPayload } from '../../../orders';
import { LoyaltyService } from '../../application/loyalty.service';
import { ReferralService } from '../../application/referral.service';

/**
 * El CRM reacciona a Pedidos (idempotente):
 *  - OrderDelivered → puntos pendientes del cliente y calificación de su referido.
 *  - ReturnRefunded → reversa proporcional de los puntos del pedido.
 * Si un handler falla, el relay reintenta el evento completo: por eso los dos son idempotentes
 * (índice único de reference en los puntos, estado del referido).
 */
@Injectable()
export class CrmConsumer implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly loyalty: LoyaltyService,
    private readonly referrals: ReferralService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<OrderDeliveredPayload>(ORDER_DELIVERED, 'crm.loyalty', (e) => this.loyalty.onOrderDelivered(e.tenantId, e.payload));
    this.bus.subscribe<OrderDeliveredPayload>(ORDER_DELIVERED, 'crm.referrals', (e) => this.referrals.onOrderDelivered(e.tenantId, e.payload));
    this.bus.subscribe<ReturnEventPayload>(RETURN_REFUNDED, 'crm.loyalty', (e) => this.loyalty.onReturnRefunded(e.tenantId, e.payload));
  }
}
