import { fromCents, toCents } from '../../../shared-kernel';
import {
  BuyXGetYBenefit,
  CouponProps,
  FixedBenefit,
  FreeShippingBenefit,
  normalizeCouponCode,
  PercentBenefit,
  PromotionConditions,
  PromotionProps,
  PromotionType,
  TieredBenefit,
} from './promotion';

/**
 * Motor de reglas de promociones. Es una función pura: recibe las líneas del carrito, las
 * promociones automáticas vigentes y los cupones ingresados (con sus contadores de uso) y
 * decide qué se aplica, cuánto descuenta cada promoción en cada línea y por qué se rechaza
 * cada cupón. No lee la base ni el reloj: todo llega en EngineInput.
 *
 * Reglas:
 *  1. Validez: activa, dentro de [starts_at, ends_at) y con usos disponibles (promoción y cupón,
 *     global y por cliente; un cupón asignado solo lo usa su dueño).
 *  2. Orden: priority ascendente; a igual prioridad, las automáticas antes que los cupones, y
 *     los cupones en el orden en que se ingresaron.
 *  3. Condiciones (alcance, monto y unidades mínimas) se miden sobre las líneas del alcance
 *     ANTES de descuentos, así el resultado no depende del orden de las otras promociones.
 *  4. Combinación: la primera promoción aplicable siempre entra. Las siguientes solo entran si
 *     ella y todas las ya aplicadas son stackable. Una no combinable rechaza a las demás.
 *  5. Cada descuento se calcula sobre lo que queda de cada línea después de los anteriores, así
 *     una línea nunca queda negativa. Los montos se reparten por línea (para el IVA) con el
 *     método del mayor residuo: la suma por línea es exactamente el descuento de la promoción.
 */

export interface PricingLine {
  /** Identificador de la línea en el carrito (el variantId). */
  lineId: string;
  variantId: string;
  productId: string;
  categoryPath: string | null;
  brandId: string | null;
  quantity: number;
  /** Precio unitario SIN IVA en centavos. */
  unitPriceCents: number;
}

export type CouponUsage = CouponProps & {
  /** Canjes de este cupón hechos por el cliente (por usuario o email). */
  customerUses: number;
};

export interface EngineInput {
  now: Date;
  userId: string | null;
  lines: PricingLine[];
  /** Promociones sin cupón candidatas (el motor vuelve a verificar su vigencia). */
  automatic: PromotionProps[];
  /** Códigos ingresados por el cliente, en su orden. */
  couponCodes: string[];
  /** Cupones encontrados para esos códigos, con su promoción. */
  coupons: { coupon: CouponUsage; promotion: PromotionProps }[];
  /** Costo de envío si ya se conoce (checkout); en el carrito es null. */
  shippingCents?: number | null;
}

export const REJECTION_REASONS = [
  'COUPON_NOT_FOUND',
  'PROMOTION_NOT_ACTIVE',
  'PROMOTION_NOT_STARTED',
  'PROMOTION_EXPIRED',
  'PROMOTION_USAGE_LIMIT',
  'COUPON_USAGE_LIMIT',
  'COUPON_CUSTOMER_LIMIT',
  'COUPON_NOT_ASSIGNED',
  'CONDITIONS_NOT_MET',
  'NOT_COMBINABLE',
  'DUPLICATE_PROMOTION',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface CouponRejection {
  code: string;
  reason: RejectionReason;
  message: string;
  details?: Record<string, unknown>;
}

export interface LineAllocation {
  lineId: string;
  amountCents: number;
}

export interface AppliedPromotion {
  promotionId: string;
  name: string;
  type: PromotionType;
  stackable: boolean;
  couponId: string | null;
  couponCode: string | null;
  /** Descuento sobre productos (suma de allocations). */
  discountCents: number;
  freeShipping: boolean;
  shippingDiscountCents: number;
  allocations: LineAllocation[];
}

/** Promoción automática que no aplica por monto mínimo: "te faltan $X para ...". */
export interface PromotionHint {
  promotionId: string;
  name: string;
  type: PromotionType;
  missingCents: number;
}

export interface EngineResult {
  applied: AppliedPromotion[];
  rejectedCoupons: CouponRejection[];
  hints: PromotionHint[];
  /** Descuento total por línea (lineId → centavos). */
  lineDiscounts: Map<string, number>;
  discountTotalCents: number;
  freeShipping: boolean;
  shippingDiscountCents: number;
}

type Problem = { reason: RejectionReason; message: string; details?: Record<string, unknown> };

// ---------------------------------------------------------------------------------------

/**
 * Reparte `total` en proporción a `weights` (enteros ≥ 0) sin perder ni inventar centavos:
 * pisos de la parte proporcional y el resto, un centavo a la vez, a los mayores residuos
 * (a igual residuo, la línea anterior). Nunca asigna a una línea más que su peso.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  if (total >= sum) return [...weights];
  const exact = weights.map((w) => (w * total) / sum);
  const result = exact.map(Math.floor);
  let rest = total - result.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, frac: e - result[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k++, rest--) result[order[k].i]++;
  return result;
}

const pctBp = (percent: number) => Math.round(percent * 100);
const applyPct = (cents: number, percent: number) => Math.round((cents * pctBp(percent)) / 10_000);

export function lineInScope(c: PromotionConditions, line: PricingLine): boolean {
  if (c.excludeVariantIds?.includes(line.variantId)) return false;
  if (c.excludeProductIds?.includes(line.productId)) return false;
  if (c.productIds && !c.productIds.includes(line.productId)) return false;
  if (c.variantIds && !c.variantIds.includes(line.variantId)) return false;
  if (c.brandIds && (!line.brandId || !c.brandIds.includes(line.brandId))) return false;
  if (c.categoryPaths) {
    const path = line.categoryPath?.toLowerCase();
    if (!path || !c.categoryPaths.some((p) => path === p || path.startsWith(`${p}/`))) return false;
  }
  return true;
}

function checkPromotion(p: PromotionProps, now: Date): Problem | null {
  if (!p.active) return { reason: 'PROMOTION_NOT_ACTIVE', message: 'La promoción no está activa' };
  if (p.startsAt.getTime() > now.getTime()) {
    return { reason: 'PROMOTION_NOT_STARTED', message: 'La promoción todavía no empieza', details: { startsAt: p.startsAt } };
  }
  if (p.endsAt && p.endsAt.getTime() <= now.getTime()) {
    return { reason: 'PROMOTION_EXPIRED', message: 'La promoción ya terminó', details: { endsAt: p.endsAt } };
  }
  if (p.maxUses !== null && p.usedCount >= p.maxUses) {
    return { reason: 'PROMOTION_USAGE_LIMIT', message: 'La promoción agotó sus usos' };
  }
  return null;
}

function checkCoupon(c: CouponUsage, userId: string | null): Problem | null {
  if (c.assignedUserId && c.assignedUserId !== userId) {
    return {
      reason: 'COUPON_NOT_ASSIGNED',
      message: userId ? 'Este cupón pertenece a otro cliente' : 'Inicia sesión para usar este cupón personal',
    };
  }
  if (c.maxUses !== null && c.usedCount >= c.maxUses) {
    return { reason: 'COUPON_USAGE_LIMIT', message: 'El cupón agotó sus usos' };
  }
  if (c.customerUses >= c.maxUsesPerCustomer) {
    return {
      reason: 'COUPON_CUSTOMER_LIMIT',
      message:
        c.maxUsesPerCustomer === 1 ? 'Ya usaste este cupón' : `Ya usaste este cupón ${c.maxUsesPerCustomer} veces (máximo)`,
      details: { maxUsesPerCustomer: c.maxUsesPerCustomer },
    };
  }
  return null;
}

type Outcome =
  | { ok: true; allocations: Map<string, number>; freeShipping: boolean; shippingDiscountCents: number }
  | { ok: false; message: string; missingCents?: number; details?: Record<string, unknown> };

const notMet = (message: string, details?: Record<string, unknown>, missingCents?: number): Outcome => ({
  ok: false,
  message,
  details,
  missingCents,
});

/** Reparte un descuento total entre las líneas elegibles según lo que les queda. */
function spread(total: number, eligible: PricingLine[], remaining: Map<string, number>): Map<string, number> {
  const weights = eligible.map((l) => remaining.get(l.lineId) ?? 0);
  const parts = allocate(total, weights);
  return new Map(eligible.map((l, i) => [l.lineId, parts[i]]));
}

function remainingOf(eligible: PricingLine[], remaining: Map<string, number>): number {
  return eligible.reduce((s, l) => s + (remaining.get(l.lineId) ?? 0), 0);
}

function percentOutcome(percent: number, maxDiscount: string | undefined, eligible: PricingLine[], remaining: Map<string, number>) {
  let discount = applyPct(remainingOf(eligible, remaining), percent);
  if (maxDiscount !== undefined) discount = Math.min(discount, toCents(maxDiscount));
  return spread(discount, eligible, remaining);
}

function amountOutcome(amount: string, eligible: PricingLine[], remaining: Map<string, number>) {
  return spread(Math.min(toCents(amount), remainingOf(eligible, remaining)), eligible, remaining);
}

function buyXGetY(b: BuyXGetYBenefit, eligible: PricingLine[], remaining: Map<string, number>): Outcome {
  const group = b.buyQuantity + b.getQuantity;
  // Una entrada por unidad, de la más cara a la más barata: las más baratas son las "de regalo".
  const units = eligible
    .flatMap((l, index) => Array.from({ length: l.quantity }, () => ({ lineId: l.lineId, price: l.unitPriceCents, index })))
    .sort((x, y) => y.price - x.price || x.index - y.index);
  let applications = Math.floor(units.length / group);
  if (b.maxApplications !== undefined) applications = Math.min(applications, b.maxApplications);
  if (applications === 0) {
    return notMet(`Lleva ${group} unidades participantes para aplicar la promoción`, { requiredQuantity: group });
  }
  const discounted = units.slice(units.length - applications * b.getQuantity);
  const allocations = new Map<string, number>();
  for (const u of discounted) allocations.set(u.lineId, (allocations.get(u.lineId) ?? 0) + applyPct(u.price, b.percentOff));
  for (const [lineId, amount] of allocations) allocations.set(lineId, Math.min(amount, remaining.get(lineId) ?? 0));
  return { ok: true, allocations, freeShipping: false, shippingDiscountCents: 0 };
}

function computeBenefit(
  p: PromotionProps,
  lines: PricingLine[],
  remaining: Map<string, number>,
  remainingShipping: number | null,
): Outcome {
  const eligible = lines.filter((l) => lineInScope(p.conditions, l));
  if (eligible.length === 0) return notMet('Ningún producto del carrito participa en la promoción');

  const gross = eligible.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0);
  const quantity = eligible.reduce((s, l) => s + l.quantity, 0);
  const { minSubtotal, minQuantity } = p.conditions;
  if (minSubtotal !== undefined && gross < toCents(minSubtotal)) {
    const missing = toCents(minSubtotal) - gross;
    return notMet(
      `Agrega $${fromCents(missing)} más en productos participantes (mínimo $${minSubtotal})`,
      { minSubtotal, missing: fromCents(missing) },
      missing,
    );
  }
  if (minQuantity !== undefined && quantity < minQuantity) {
    return notMet(`Lleva al menos ${minQuantity} unidades participantes`, { minQuantity });
  }

  const ok = (allocations: Map<string, number>): Outcome => ({ ok: true, allocations, freeShipping: false, shippingDiscountCents: 0 });

  switch (p.type) {
    case 'percent': {
      const b = p.benefit as PercentBenefit;
      return ok(percentOutcome(b.percent, b.maxDiscount, eligible, remaining));
    }
    case 'fixed':
      return ok(amountOutcome((p.benefit as FixedBenefit).amount, eligible, remaining));
    case 'buy_x_get_y':
      return buyXGetY(p.benefit as BuyXGetYBenefit, eligible, remaining);
    case 'free_shipping': {
      const max = (p.benefit as FreeShippingBenefit).maxDiscount;
      const shipping = remainingShipping ?? 0;
      const covered = max === undefined ? shipping : Math.min(shipping, toCents(max));
      return { ok: true, allocations: new Map(), freeShipping: true, shippingDiscountCents: covered };
    }
    case 'tiered': {
      const b = p.benefit as TieredBenefit;
      const measure = b.basis === 'subtotal' ? gross : quantity;
      const minOf = (t: (typeof b.tiers)[number]) => (b.basis === 'subtotal' ? toCents(t.min as string) : (t.min as number));
      const tier = [...b.tiers].reverse().find((t) => minOf(t) <= measure);
      if (!tier) {
        const first = b.tiers[0];
        if (b.basis === 'subtotal') {
          const missing = minOf(first) - measure;
          return notMet(
            `Agrega $${fromCents(missing)} más en productos participantes para el primer tramo`,
            { minSubtotal: first.min, missing: fromCents(missing) },
            missing,
          );
        }
        return notMet(`Lleva al menos ${first.min} unidades participantes para el primer tramo`, { minQuantity: first.min });
      }
      return ok(
        tier.percent !== undefined
          ? percentOutcome(tier.percent, undefined, eligible, remaining)
          : amountOutcome(tier.amount!, eligible, remaining),
      );
    }
  }
}

interface QueueEntry {
  promotion: PromotionProps;
  coupon: CouponUsage | null;
  code: string | null;
  order: number;
}

export function evaluatePromotions(input: EngineInput): EngineResult {
  const rejected: CouponRejection[] = [];
  const queue: QueueEntry[] = [];

  // 1) Validez de cupones y promociones automáticas.
  const byCode = new Map(input.coupons.map((c) => [normalizeCouponCode(c.coupon.code), c]));
  const seen = new Set<string>();
  input.couponCodes.forEach((raw, index) => {
    const code = normalizeCouponCode(raw);
    if (seen.has(code)) return;
    seen.add(code);
    const found = byCode.get(code);
    if (!found) {
      rejected.push({ code, reason: 'COUPON_NOT_FOUND', message: 'El cupón no existe' });
      return;
    }
    const problem = checkPromotion(found.promotion, input.now) ?? checkCoupon(found.coupon, input.userId);
    if (problem) {
      rejected.push({ code, ...problem });
      return;
    }
    queue.push({ promotion: found.promotion, coupon: found.coupon, code, order: 1_000_000 + index });
  });
  input.automatic.forEach((promotion, index) => {
    if (promotion.requiresCoupon || checkPromotion(promotion, input.now)) return;
    queue.push({ promotion, coupon: null, code: null, order: index });
  });

  // 2) Orden de evaluación.
  queue.sort((a, b) => a.promotion.priority - b.promotion.priority || a.order - b.order);

  // 3) Aplicación secuencial.
  const remaining = new Map(input.lines.map((l) => [l.lineId, l.quantity * l.unitPriceCents]));
  let remainingShipping = input.shippingCents ?? null;
  const applied: AppliedPromotion[] = [];
  const hints: PromotionHint[] = [];

  for (const entry of queue) {
    const p = entry.promotion;
    if (applied.some((a) => a.promotionId === p.id)) {
      if (entry.code) {
        rejected.push({ code: entry.code, reason: 'DUPLICATE_PROMOTION', message: 'La promoción de este cupón ya está aplicada' });
      }
      continue;
    }

    let outcome = computeBenefit(p, input.lines, remaining, remainingShipping);
    if (outcome.ok && p.type !== 'free_shipping' && [...outcome.allocations.values()].every((v) => v === 0)) {
      outcome = notMet('La promoción no genera descuento sobre este carrito');
    }
    if (!outcome.ok) {
      if (entry.code) {
        rejected.push({ code: entry.code, reason: 'CONDITIONS_NOT_MET', message: outcome.message, details: outcome.details });
      } else if (outcome.missingCents !== undefined) {
        hints.push({ promotionId: p.id, name: p.name, type: p.type, missingCents: outcome.missingCents });
      }
      continue;
    }

    if (applied.length > 0 && (!p.stackable || applied.some((a) => !a.stackable))) {
      if (entry.code) {
        const others = applied.map((a) => a.name);
        rejected.push({
          code: entry.code,
          reason: 'NOT_COMBINABLE',
          message: `No es combinable con: ${others.join(', ')}`,
          details: { conflictsWith: applied.map((a) => a.promotionId) },
        });
      }
      continue;
    }

    const allocations: LineAllocation[] = [];
    for (const line of input.lines) {
      const amount = outcome.allocations.get(line.lineId) ?? 0;
      if (amount <= 0) continue;
      remaining.set(line.lineId, (remaining.get(line.lineId) ?? 0) - amount);
      allocations.push({ lineId: line.lineId, amountCents: amount });
    }
    if (remainingShipping !== null) remainingShipping -= outcome.shippingDiscountCents;
    applied.push({
      promotionId: p.id,
      name: p.name,
      type: p.type,
      stackable: p.stackable,
      couponId: entry.coupon?.id ?? null,
      couponCode: entry.code,
      discountCents: allocations.reduce((s, a) => s + a.amountCents, 0),
      freeShipping: outcome.freeShipping,
      shippingDiscountCents: outcome.shippingDiscountCents,
      allocations,
    });
  }

  const lineDiscounts = new Map(input.lines.map((l) => [l.lineId, l.quantity * l.unitPriceCents - (remaining.get(l.lineId) ?? 0)]));
  return {
    applied,
    rejectedCoupons: rejected,
    hints,
    lineDiscounts,
    discountTotalCents: applied.reduce((s, a) => s + a.discountCents, 0),
    freeShipping: applied.some((a) => a.freeShipping),
    shippingDiscountCents: applied.reduce((s, a) => s + a.shippingDiscountCents, 0),
  };
}
