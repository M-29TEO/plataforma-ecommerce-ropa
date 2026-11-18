import { Injectable } from '@nestjs/common';
import { Database, fromCents, toCents } from '../../../shared-kernel';
import { CouponRejection, CouponUsage, evaluatePromotions, PricingLine } from '../domain/engine';
import { customerKeysFor, normalizeCouponCode, PromotionType } from '../domain/promotion';
import { PromotionRepository } from './ports';

export interface PricingLineInput {
  lineId: string;
  variantId: string;
  productId: string;
  categoryPath: string | null;
  brandId: string | null;
  quantity: number;
  /** Precio unitario SIN IVA ("19.90"). */
  unitPrice: string;
}

export interface EvaluateInput {
  tenantId: string;
  userId: string | null;
  /** Email de contacto: identifica al invitado para los límites por cliente. */
  email: string | null;
  couponCodes: string[];
  lines: PricingLineInput[];
  shippingTotal?: string | null;
  now?: Date;
}

export interface AppliedPromotionView {
  promotionId: string;
  name: string;
  type: PromotionType;
  couponId: string | null;
  couponCode: string | null;
  discount: string;
  freeShipping: boolean;
  shippingDiscount: string;
  allocations: { lineId: string; amount: string }[];
}

/** Resultado del motor con montos como string (formato de la API y de numeric(12,2)). */
export interface PricingResult {
  applied: AppliedPromotionView[];
  rejectedCoupons: CouponRejection[];
  hints: { promotionId: string; name: string; type: PromotionType; missing: string }[];
  /** Descuento por línea (lineId → monto). */
  lineDiscounts: Record<string, string>;
  discountTotal: string;
  freeShipping: boolean;
  shippingDiscount: string;
}

/**
 * Carga lo que necesita el motor (promociones automáticas vigentes, cupones ingresados y
 * cuántas veces los usó el cliente) y lo evalúa. Solo lee: el cupo se toma al canjear.
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly db: Database,
    private readonly promotions: PromotionRepository,
  ) {}

  async evaluate(input: EvaluateInput): Promise<PricingResult> {
    const now = input.now ?? new Date();
    const codes = [...new Set(input.couponCodes.map(normalizeCouponCode).filter(Boolean))];
    const [automatic, found] = await Promise.all([
      this.promotions.findAutomatic(this.db, input.tenantId, now),
      codes.length ? this.promotions.findCouponsByCodes(this.db, input.tenantId, codes) : Promise.resolve([]),
    ]);
    const keys = customerKeysFor(input.userId, input.email);
    const uses =
      found.length && (keys.length || input.userId)
        ? await this.promotions.countCustomerUses(this.db, found.map((f) => f.coupon.id), keys, input.userId)
        : new Map<string, number>();
    const coupons = found.map((f) => ({
      promotion: f.promotion,
      coupon: { ...f.coupon, customerUses: uses.get(f.coupon.id) ?? 0 } satisfies CouponUsage,
    }));

    const lines: PricingLine[] = input.lines.map((l) => ({ ...l, unitPriceCents: toCents(l.unitPrice) }));
    const result = evaluatePromotions({
      now,
      userId: input.userId,
      lines,
      automatic,
      couponCodes: codes,
      coupons,
      shippingCents: input.shippingTotal === undefined || input.shippingTotal === null ? null : toCents(input.shippingTotal),
    });

    return {
      applied: result.applied.map((a) => ({
        promotionId: a.promotionId,
        name: a.name,
        type: a.type,
        couponId: a.couponId,
        couponCode: a.couponCode,
        discount: fromCents(a.discountCents),
        freeShipping: a.freeShipping,
        shippingDiscount: fromCents(a.shippingDiscountCents),
        allocations: a.allocations.map((x) => ({ lineId: x.lineId, amount: fromCents(x.amountCents) })),
      })),
      rejectedCoupons: result.rejectedCoupons,
      hints: result.hints.map((h) => ({ promotionId: h.promotionId, name: h.name, type: h.type, missing: fromCents(h.missingCents) })),
      lineDiscounts: Object.fromEntries([...result.lineDiscounts].map(([id, cents]) => [id, fromCents(cents)])),
      discountTotal: fromCents(result.discountTotalCents),
      freeShipping: result.freeShipping,
      shippingDiscount: fromCents(result.shippingDiscountCents),
    };
  }
}
