import { Injectable } from '@nestjs/common';
import { Database, isUniqueViolation, toCents, ValidationError } from '../../../shared-kernel';
import { CustomerIdentityRequiredError, RedemptionRejectedError } from '../domain/errors';
import { customerKeysFor } from '../domain/promotion';
import { NewRedemption, PromotionRepository, Redemption } from './ports';

export interface RedeemInput {
  tenantId: string;
  /** Mismo id que usan la reserva de stock y el pedido. */
  orderId: string;
  userId: string | null;
  email: string | null;
  /** Lo que devolvió evaluate() en el checkout (applied[]). */
  promotions: { promotionId: string; couponId?: string | null; discount: string }[];
}

/**
 * Canje de promociones al confirmar el checkout. Es donde se hacen cumplir los límites de uso
 * de forma atómica (evaluate() solo los consulta):
 *
 *  - Global del cupón y de la promoción: UPDATE ... SET used_count = used_count + 1
 *    WHERE max_uses IS NULL OR used_count < max_uses. Con N pedidos simultáneos por el último
 *    cupo, solo uno obtiene la fila; los demás ven 0 filas.
 *  - Por cliente: el UPDATE deja bloqueada la fila del cupón hasta el COMMIT, así que el conteo
 *    de canjes del cliente que viene después ya ve los canjes confirmados de otros pedidos.
 *
 * Todo o nada, e idempotente por pedido: si el pedido ya tiene canjes, se devuelven sin tocar
 * contadores (índice único (order_id, promotion_id) para reintentos simultáneos).
 * Orden de bloqueo fijo (cupones por id, luego promociones por id) para evitar deadlocks.
 */
@Injectable()
export class RedemptionService {
  constructor(
    private readonly db: Database,
    private readonly promotions: PromotionRepository,
  ) {}

  async redeem(input: RedeemInput): Promise<Redemption[]> {
    if (input.promotions.length === 0) return [];
    const keys = customerKeysFor(input.userId, input.email);
    if (keys.length === 0) throw new CustomerIdentityRequiredError();
    const ids = input.promotions.map((p) => p.promotionId);
    if (new Set(ids).size !== ids.length) {
      throw new ValidationError('DUPLICATE_PROMOTION', 'Una promoción no puede canjearse dos veces en el mismo pedido');
    }
    for (const p of input.promotions) {
      if (toCents(p.discount) < 0) throw new ValidationError('INVALID_MONEY', 'El descuento no puede ser negativo');
    }

    try {
      return await this.db.withTransaction(async (tx) => {
        const existing = await this.promotions.findRedemptionsByOrder(tx, input.tenantId, input.orderId);
        if (existing.length > 0) return existing;

        const withCoupon = input.promotions.filter((p) => p.couponId).sort((a, b) => a.couponId!.localeCompare(b.couponId!));
        for (const p of withCoupon) {
          const coupon = await this.promotions.takeCouponUse(tx, input.tenantId, p.couponId!, p.promotionId);
          if (!coupon) {
            throw new RedemptionRejectedError('COUPON_USAGE_LIMIT', 'El cupón agotó sus usos', { couponId: p.couponId });
          }
          if (coupon.assignedUserId && coupon.assignedUserId !== input.userId) {
            throw new RedemptionRejectedError('COUPON_NOT_ASSIGNED', 'Este cupón pertenece a otro cliente', { code: coupon.code });
          }
          const uses = await this.promotions.countCustomerUses(tx, [coupon.id], keys, input.userId, input.orderId);
          if ((uses.get(coupon.id) ?? 0) >= coupon.maxUsesPerCustomer) {
            throw new RedemptionRejectedError('COUPON_CUSTOMER_LIMIT', 'Ya usaste este cupón', {
              code: coupon.code,
              maxUsesPerCustomer: coupon.maxUsesPerCustomer,
            });
          }
        }
        for (const promotionId of [...ids].sort()) {
          if (!(await this.promotions.takePromotionUse(tx, input.tenantId, promotionId))) {
            throw new RedemptionRejectedError(
              'PROMOTION_USAGE_LIMIT',
              'La promoción ya no está disponible (sin usos, vencida o desactivada)',
              { promotionId },
            );
          }
        }

        const rows: NewRedemption[] = input.promotions.map((p) => ({
          promotionId: p.promotionId,
          couponId: p.couponId ?? null,
          orderId: input.orderId,
          userId: input.userId,
          customerKey: keys[0],
          discount: p.discount,
        }));
        await this.promotions.insertRedemptions(tx, rows);
        return this.promotions.findRedemptionsByOrder(tx, input.tenantId, input.orderId);
      });
    } catch (error) {
      // Otro reintento del mismo pedido ganó la carrera: su resultado es el nuestro.
      if (isUniqueViolation(error, 'ux_redemptions_order_promotion')) {
        return this.promotions.findRedemptionsByOrder(this.db, input.tenantId, input.orderId);
      }
      throw error;
    }
  }

  /** Pedido cancelado o pago fallido: devuelve los cupos y borra los canjes. Idempotente. */
  revert(tenantId: string, orderId: string): Promise<{ reverted: number }> {
    return this.db.withTransaction(async (tx) => {
      const redemptions = await this.promotions.findRedemptionsByOrder(tx, tenantId, orderId, { forUpdate: true });
      if (redemptions.length === 0) return { reverted: 0 };
      const couponIds = redemptions.map((r) => r.couponId).filter((id): id is string => id !== null).sort();
      for (const id of couponIds) await this.promotions.releaseCouponUse(tx, id);
      for (const id of redemptions.map((r) => r.promotionId).sort()) await this.promotions.releasePromotionUse(tx, id);
      await this.promotions.deleteRedemptions(tx, redemptions.map((r) => r.id));
      return { reverted: redemptions.length };
    });
  }
}
