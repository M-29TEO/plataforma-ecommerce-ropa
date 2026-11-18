import { Module } from '@nestjs/common';
import { GiftCardsController } from './api/gift-cards.controller';
import { PromotionsController } from './api/promotions.controller';
import { GiftCardService } from './application/gift-card.service';
import { GiftCardRepository, PromotionRepository } from './application/ports';
import { PricingService } from './application/pricing.service';
import { PromotionService } from './application/promotion.service';
import { PromotionsApi } from './application/promotions.api';
import { RedemptionService } from './application/redemption.service';
import { PromotionsConsumer } from './infrastructure/consumers/promotions.consumer';
import { PgGiftCardRepository } from './infrastructure/pg-gift-card.repository';
import { PgPromotionRepository } from './infrastructure/pg-promotion.repository';
import { PromotionsPersonalDataContributor } from './infrastructure/personal-data.contributor';

/**
 * Módulo Promociones (schema sales: promotions, coupons, promotion_redemptions, gift_cards,
 * gift_card_transactions). Requiere ConfigModule y DatabaseModule del shared kernel.
 */
@Module({
  controllers: [PromotionsController, GiftCardsController],
  providers: [
    { provide: PromotionRepository, useClass: PgPromotionRepository },
    { provide: GiftCardRepository, useClass: PgGiftCardRepository },
    PromotionService,
    PricingService,
    RedemptionService,
    GiftCardService,
    PromotionsApi,
    PromotionsPersonalDataContributor,
  ],
  // Los servicios se exportan solo para PromotionsConsumersModule (index.ts no los expone).
  exports: [PromotionsApi, RedemptionService, GiftCardService],
})
export class PromotionsModule {}

/** Consumidores de eventos de Pedidos (proceso worker; en tests, junto con el relay). */
@Module({ imports: [PromotionsModule], providers: [PromotionsConsumer] })
export class PromotionsConsumersModule {}
