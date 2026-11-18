import { Injectable } from '@nestjs/common';
import { GiftCardBalance, GiftCardRedemption, GiftCardService } from './gift-card.service';
import { IssuedGiftCard } from './ports';
import { Redemption } from './ports';
import { EvaluateInput, PricingResult, PricingService } from './pricing.service';
import { IssuedRewardCoupon, PromotionService, RewardCouponInput } from './promotion.service';
import { RedeemInput, RedemptionService } from './redemption.service';

/**
 * Fachada síncrona para otros módulos. Carrito evalúa promociones en cada vista; Checkout
 * canjea (toma cupos y saldo) al confirmar y revierte si el pedido se cancela o el pago falla.
 */
@Injectable()
export class PromotionsApi {
  constructor(
    private readonly pricing: PricingService,
    private readonly redemptions: RedemptionService,
    private readonly giftCards: GiftCardService,
    private readonly promotions: PromotionService,
  ) {}

  /** Solo lectura: qué promociones aplican, cuánto por línea y por qué se rechaza cada cupón. */
  evaluate(input: EvaluateInput): Promise<PricingResult> {
    return this.pricing.evaluate(input);
  }

  /** Toma los cupos de forma atómica. Idempotente por orderId. Lanza RedemptionRejectedError. */
  redeem(input: RedeemInput): Promise<Redemption[]> {
    return this.redemptions.redeem(input);
  }

  /** Devuelve los cupos de un pedido cancelado. Idempotente. */
  revertRedemptions(tenantId: string, orderId: string): Promise<{ reverted: number }> {
    return this.redemptions.revert(tenantId, orderId);
  }

  getGiftCardBalance(tenantId: string, code: string): Promise<GiftCardBalance> {
    return this.giftCards.balance(tenantId, code);
  }

  /** Descuenta saldo. Idempotente por (tarjeta, pedido). */
  redeemGiftCard(tenantId: string, code: string, orderId: string, amount: string): Promise<GiftCardRedemption> {
    return this.giftCards.redeem(tenantId, code, orderId, amount);
  }

  /**
   * Saldo a favor (reembolso de una devolución en gift card): tarjeta activa nueva. Devuelve el
   * código en claro UNA sola vez; el llamador debe entregarlo al cliente en la misma transacción.
   */
  async issueGiftCard(input: { tenantId: string; amount: string; recipientEmail: string | null; purchaserId: string | null }): Promise<IssuedGiftCard> {
    const { giftCard, code } = await this.giftCards.issue({ ...input, status: 'active' });
    return { giftCardId: giftCard.id, last4: giftCard.last4, balance: giftCard.balance, code };
  }

  /** Devuelve saldo a las tarjetas usadas en el pedido (todo, o hasta `amount`). */
  refundGiftCards(tenantId: string, orderId: string, amount?: string): Promise<{ refunded: string }> {
    return this.giftCards.refundOrder(tenantId, orderId, amount);
  }

  /**
   * Cupón personal de recompensa (referidos): un uso, asignado al cliente, bajo la promoción de
   * sistema con ese nombre (se crea la primera vez). null si el backoffice desactivó la promoción.
   */
  issueRewardCoupon(input: RewardCouponInput): Promise<IssuedRewardCoupon | null> {
    return this.promotions.issueRewardCoupon(input);
  }
}
