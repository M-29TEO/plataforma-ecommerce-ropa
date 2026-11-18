import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventBus } from '../../../../shared-kernel';
import { ORDER_CANCELLED } from '../../../orders';
import type { OrderCancelledPayload } from '../../../orders';
import { GiftCardService } from '../../application/gift-card.service';
import { RedemptionService } from '../../application/redemption.service';

/** OrderCancelled → devuelve los cupos de cupones/promociones y el saldo de gift cards. Idempotente. */
@Injectable()
export class PromotionsConsumer implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly redemptions: RedemptionService,
    private readonly giftCards: GiftCardService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<OrderCancelledPayload>(ORDER_CANCELLED, 'promotions', async (e) => {
      await this.redemptions.revert(e.tenantId, e.payload.orderId);
      await this.giftCards.refundOrder(e.tenantId, e.payload.orderId);
    });
  }
}
