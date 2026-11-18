import { allocate, CouponUsage, EngineInput, evaluatePromotions, PricingLine } from './engine';
import { PromotionProps, validatePromotionDefinition } from './promotion';

const NOW = new Date('2026-09-29T15:00:00Z');
let seq = 0;

type PromoOverrides = Partial<Omit<PromotionProps, 'conditions' | 'benefit' | 'type'>> & { conditions?: Record<string, unknown> };

/** Promoción válida (pasa por la misma validación que la API). */
function promo(type: string, benefit: Record<string, unknown>, overrides: PromoOverrides = {}): PromotionProps {
  const { conditions, ...rest } = overrides;
  const def = validatePromotionDefinition({ type, conditions: conditions ?? {}, benefit });
  seq++;
  return {
    id: `p${String(seq).padStart(3, '0')}`,
    tenantId: 't',
    name: `Promo ${seq}`,
    ...def,
    requiresCoupon: false,
    stackable: false,
    priority: 100,
    maxUses: null,
    usedCount: 0,
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
    active: true,
    createdAt: NOW,
    ...rest,
  };
}

function coupon(code: string, p: PromotionProps, overrides: Partial<CouponUsage> = {}) {
  return {
    promotion: { ...p, requiresCoupon: true },
    coupon: {
      id: `c-${code}`,
      promotionId: p.id,
      tenantId: 't',
      code,
      maxUses: null,
      maxUsesPerCustomer: 1,
      usedCount: 0,
      assignedUserId: null,
      customerUses: 0,
      ...overrides,
    } satisfies CouponUsage,
  };
}

// Carrito base: 100.00 sin IVA.
const BLUSA: PricingLine = { lineId: 'A', variantId: 'A', productId: 'blusa', categoryPath: 'mujer/blusas', brandId: 'andina', quantity: 2, unitPriceCents: 2000 };
const JEAN: PricingLine = { lineId: 'B', variantId: 'B', productId: 'jean', categoryPath: 'hombre/jeans', brandId: 'pacifico', quantity: 1, unitPriceCents: 4500 };
const MEDIAS: PricingLine = { lineId: 'C', variantId: 'C', productId: 'medias', categoryPath: 'unisex/medias', brandId: null, quantity: 3, unitPriceCents: 500 };
const CART = [BLUSA, JEAN, MEDIAS];

function run(overrides: Partial<EngineInput>) {
  return evaluatePromotions({ now: NOW, userId: 'u1', lines: CART, automatic: [], couponCodes: [], coupons: [], ...overrides });
}

function withCoupons(list: ReturnType<typeof coupon>[], extra: Partial<EngineInput> = {}) {
  return run({ couponCodes: list.map((c) => c.coupon.code), coupons: list, ...extra });
}

const allocationsOf = (r: ReturnType<typeof run>, i = 0) =>
  Object.fromEntries(r.applied[i].allocations.map((a) => [a.lineId, a.amountCents]));

describe('allocate (reparto por línea, mayor residuo)', () => {
  it('reparte sin perder ni inventar centavos', () => {
    expect(allocate(100, [100, 100, 100])).toEqual([34, 33, 33]);
    expect(allocate(1, [1, 1])).toEqual([1, 0]);
    expect(allocate(3333, [4000, 4500, 1500])).toEqual([1333, 1500, 500]);
  });

  it('nunca asigna más que el peso de la línea', () => {
    expect(allocate(99_999, [300, 200])).toEqual([300, 200]);
    const parts = allocate(777, [1, 998, 1]);
    parts.forEach((p, i) => expect(p).toBeLessThanOrEqual([1, 998, 1][i]));
    expect(parts.reduce((a, b) => a + b)).toBe(777);
  });

  it('total 0 o pesos 0 → ceros', () => {
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(10, [0, 0])).toEqual([0, 0]);
  });
});

describe('Motor de promociones · percent', () => {
  it('10 % sobre todo el carrito, repartido por línea', () => {
    const r = run({ automatic: [promo('percent', { percent: 10 })] });
    expect(r.discountTotalCents).toBe(1000);
    expect(allocationsOf(r)).toEqual({ A: 400, B: 450, C: 150 });
    expect(r.lineDiscounts.get('A')).toBe(400);
  });

  it('respeta el alcance por categoría (incluye subcategorías)', () => {
    const r = run({ automatic: [promo('percent', { percent: 25 }, { conditions: { categoryPaths: ['mujer'] } })] });
    expect(r.discountTotalCents).toBe(1000);
    expect(allocationsOf(r)).toEqual({ A: 1000 });
  });

  it('respeta marcas y exclusiones', () => {
    const r = run({
      automatic: [promo('percent', { percent: 50 }, { conditions: { brandIds: ['andina', 'pacifico'], excludeProductIds: ['jean'] } })],
    });
    expect(allocationsOf(r)).toEqual({ A: 2000 });
  });

  it('tope maxDiscount', () => {
    const r = run({ automatic: [promo('percent', { percent: 10, maxDiscount: '5.00' })] });
    expect(r.discountTotalCents).toBe(500);
    expect(allocationsOf(r)).toEqual({ A: 200, B: 225, C: 75 });
  });

  it('redondea al centavo (mitad hacia arriba) y la suma por línea es exacta', () => {
    const r = run({ automatic: [promo('percent', { percent: 33.33 })] });
    expect(r.discountTotalCents).toBe(3333);
    expect(r.applied[0].allocations.reduce((s, a) => s + a.amountCents, 0)).toBe(3333);
    const single = run({ lines: [{ ...JEAN, unitPriceCents: 999 }], automatic: [promo('percent', { percent: 15 })] });
    expect(single.discountTotalCents).toBe(150); // 1.4985 → 1.50
  });
});

describe('Motor de promociones · fixed', () => {
  it('monto fijo prorrateado por línea', () => {
    const r = run({ automatic: [promo('fixed', { amount: '15.00' })] });
    expect(r.discountTotalCents).toBe(1500);
    expect(allocationsOf(r)).toEqual({ A: 600, B: 675, C: 225 });
  });

  it('nunca descuenta más que el valor de las líneas del alcance', () => {
    const r = run({ automatic: [promo('fixed', { amount: '30' }, { conditions: { productIds: ['medias'] } })] });
    expect(r.discountTotalCents).toBe(1500);
    expect(allocationsOf(r)).toEqual({ C: 1500 });
  });

  it('monto mínimo del alcance no alcanzado → no aplica y deja la pista "te faltan"', () => {
    const p = promo('fixed', { amount: '10' }, { conditions: { categoryPaths: ['mujer'], minSubtotal: '50' } });
    const r = run({ automatic: [p] });
    expect(r.applied).toEqual([]);
    expect(r.hints).toEqual([{ promotionId: p.id, name: p.name, type: 'fixed', missingCents: 1000 }]);
  });

  it('unidades mínimas', () => {
    expect(run({ automatic: [promo('fixed', { amount: '5' }, { conditions: { minQuantity: 7 } })] }).applied).toEqual([]);
    expect(run({ automatic: [promo('fixed', { amount: '5' }, { conditions: { minQuantity: 6 } })] }).discountTotalCents).toBe(500);
  });
});

describe('Motor de promociones · buy_x_get_y (2x1, 3x2)', () => {
  const twoForOne = { buyQuantity: 1, getQuantity: 1 };

  it('2x1 en medias: de 3 unidades, 1 gratis', () => {
    const r = run({ automatic: [promo('buy_x_get_y', twoForOne, { conditions: { productIds: ['medias'] } })] });
    expect(r.discountTotalCents).toBe(500);
    expect(allocationsOf(r)).toEqual({ C: 500 });
  });

  it('2x1 mezclando productos: las unidades más baratas son las gratis', () => {
    // Unidades: 45, 20, 20, 5, 5, 5 → 3 aplicaciones → gratis 5 + 5 + 5
    const r = run({ automatic: [promo('buy_x_get_y', twoForOne)] });
    expect(r.discountTotalCents).toBe(1500);
    expect(allocationsOf(r)).toEqual({ C: 1500 });
  });

  it('3x2: de 5 unidades (20, 20, 5, 5, 5) una aplicación, gratis la más barata', () => {
    const r = run({
      automatic: [promo('buy_x_get_y', { buyQuantity: 2, getQuantity: 1 }, { conditions: { excludeProductIds: ['jean'] } })],
    });
    expect(r.discountTotalCents).toBe(500);
  });

  it('segunda unidad al 50 %', () => {
    const r = run({
      automatic: [promo('buy_x_get_y', { buyQuantity: 1, getQuantity: 1, percentOff: 50 }, { conditions: { productIds: ['blusa'] } })],
    });
    expect(allocationsOf(r)).toEqual({ A: 1000 });
  });

  it('maxApplications limita las veces por pedido', () => {
    const lines = [{ ...MEDIAS, quantity: 4 }];
    expect(run({ lines, automatic: [promo('buy_x_get_y', twoForOne)] }).discountTotalCents).toBe(1000);
    expect(run({ lines, automatic: [promo('buy_x_get_y', { ...twoForOne, maxApplications: 1 })] }).discountTotalCents).toBe(500);
  });

  it('sin unidades suficientes el cupón se rechaza con CONDITIONS_NOT_MET', () => {
    const c = coupon('JEAN2X1', promo('buy_x_get_y', twoForOne, { conditions: { productIds: ['jean'] } }));
    const r = withCoupons([c]);
    expect(r.applied).toEqual([]);
    expect(r.rejectedCoupons).toEqual([
      expect.objectContaining({ code: 'JEAN2X1', reason: 'CONDITIONS_NOT_MET', details: { requiredQuantity: 2 } }),
    ]);
  });
});

describe('Motor de promociones · free_shipping por monto mínimo', () => {
  it('aplica desde el mínimo y cubre el envío si se conoce', () => {
    const r = run({ shippingCents: 350, automatic: [promo('free_shipping', {}, { conditions: { minSubtotal: '50' } })] });
    expect(r.freeShipping).toBe(true);
    expect(r.shippingDiscountCents).toBe(350);
    expect(r.discountTotalCents).toBe(0);
  });

  it('en el carrito (envío aún no cotizado) solo marca freeShipping', () => {
    const r = run({ automatic: [promo('free_shipping', {}, { conditions: { minSubtotal: '100' } })] });
    expect(r).toMatchObject({ freeShipping: true, shippingDiscountCents: 0 });
  });

  it('maxDiscount limita lo que se cubre del envío', () => {
    const r = run({ shippingCents: 800, automatic: [promo('free_shipping', { maxDiscount: '5' }, { conditions: { minSubtotal: '50' } })] });
    expect(r.shippingDiscountCents).toBe(500);
  });

  it('bajo el mínimo no aplica y deja la pista', () => {
    const p = promo('free_shipping', {}, { conditions: { minSubtotal: '120' } });
    const r = run({ automatic: [p] });
    expect(r.freeShipping).toBe(false);
    expect(r.hints).toEqual([expect.objectContaining({ promotionId: p.id, missingCents: 2000 })]);
  });
});

describe('Motor de promociones · tiered', () => {
  const bySubtotal = {
    basis: 'subtotal',
    tiers: [
      { min: '200', percent: 15 },
      { min: '50', percent: 5 },
      { min: '100', percent: 10 },
    ],
  };

  it('aplica el tramo más alto alcanzado (los tramos se ordenan al validar)', () => {
    expect(run({ automatic: [promo('tiered', bySubtotal)] }).discountTotalCents).toBe(1000);
    expect(run({ lines: [BLUSA, MEDIAS], automatic: [promo('tiered', bySubtotal)] }).discountTotalCents).toBe(275); // 55 × 5 %
  });

  it('por cantidad con montos fijos', () => {
    const tiers = { basis: 'quantity', tiers: [{ min: 3, amount: '5' }, { min: 6, amount: '12' }] };
    expect(run({ automatic: [promo('tiered', tiers)] }).discountTotalCents).toBe(1200);
    expect(run({ lines: [BLUSA, JEAN], automatic: [promo('tiered', tiers)] }).discountTotalCents).toBe(500);
  });

  it('bajo el primer tramo no aplica', () => {
    const r = run({ lines: [MEDIAS], automatic: [promo('tiered', bySubtotal)] });
    expect(r.applied).toEqual([]);
    expect(r.hints[0].missingCents).toBe(3500);
  });
});

describe('Motor de promociones · cupones combinables y no combinables', () => {
  it('dos cupones combinables se aplican en secuencia sobre lo que queda', () => {
    const a = coupon('DIEZ', promo('percent', { percent: 10 }, { stackable: true }));
    const b = coupon('OTRODIEZ', promo('percent', { percent: 10 }, { stackable: true }));
    const r = withCoupons([a, b]);
    expect(r.applied.map((x) => x.couponCode)).toEqual(['DIEZ', 'OTRODIEZ']);
    expect(r.discountTotalCents).toBe(1900); // 10.00 + 10 % de 90.00
    expect(r.rejectedCoupons).toEqual([]);
  });

  it('combinable + monto fijo: ninguna línea queda negativa', () => {
    const a = coupon('FIJO95', promo('fixed', { amount: '95' }, { stackable: true }));
    const b = coupon('FIJO10', promo('fixed', { amount: '10' }, { stackable: true }));
    const r = withCoupons([a, b]);
    expect(r.discountTotalCents).toBe(10_000);
    for (const line of CART) expect(r.lineDiscounts.get(line.lineId)).toBeLessThanOrEqual(line.quantity * line.unitPriceCents);
  });

  it('un cupón no combinable aplicado primero rechaza al siguiente', () => {
    const solo = coupon('SOLO20', promo('percent', { percent: 20 }));
    const extra = coupon('EXTRA5', promo('fixed', { amount: '5' }, { stackable: true }));
    const r = withCoupons([solo, extra]);
    expect(r.applied.map((x) => x.couponCode)).toEqual(['SOLO20']);
    expect(r.rejectedCoupons).toEqual([
      expect.objectContaining({ code: 'EXTRA5', reason: 'NOT_COMBINABLE', details: { conflictsWith: [solo.promotion.id] } }),
    ]);
    expect(r.rejectedCoupons[0].message).toContain(solo.promotion.name);
  });

  it('un combinable aplicado primero rechaza al no combinable', () => {
    const extra = coupon('EXTRA5', promo('fixed', { amount: '5' }, { stackable: true }));
    const solo = coupon('SOLO20', promo('percent', { percent: 20 }));
    const r = withCoupons([extra, solo]);
    expect(r.applied.map((x) => x.couponCode)).toEqual(['EXTRA5']);
    expect(r.rejectedCoupons).toEqual([expect.objectContaining({ code: 'SOLO20', reason: 'NOT_COMBINABLE' })]);
  });

  it('la prioridad decide cuál entra, no el orden en que se ingresaron', () => {
    const extra = coupon('EXTRA5', promo('fixed', { amount: '5' }, { stackable: true, priority: 100 }));
    const vip = coupon('VIP30', promo('percent', { percent: 30 }, { priority: 10 }));
    const r = withCoupons([extra, vip]);
    expect(r.applied.map((x) => x.couponCode)).toEqual(['VIP30']);
    expect(r.rejectedCoupons).toEqual([expect.objectContaining({ code: 'EXTRA5', reason: 'NOT_COMBINABLE' })]);
  });

  it('una promoción automática no combinable bloquea los cupones', () => {
    const auto = promo('percent', { percent: 15 }, { name: 'Cyber Monday', priority: 1 });
    const c = coupon('EXTRA5', promo('fixed', { amount: '5' }, { stackable: true }));
    const r = withCoupons([c], { automatic: [auto] });
    expect(r.applied.map((x) => x.name)).toEqual(['Cyber Monday']);
    expect(r.rejectedCoupons[0]).toMatchObject({ code: 'EXTRA5', reason: 'NOT_COMBINABLE', message: 'No es combinable con: Cyber Monday' });
  });

  it('automática combinable + cupón combinable + envío gratis combinable', () => {
    const auto = promo('percent', { percent: 10 }, { stackable: true });
    const envio = promo('free_shipping', {}, { stackable: true, conditions: { minSubtotal: '50' } });
    const c = coupon('EXTRA5', promo('fixed', { amount: '5' }, { stackable: true }));
    const r = withCoupons([c], { automatic: [auto, envio], shippingCents: 400 });
    expect(r.applied).toHaveLength(3);
    expect(r.discountTotalCents).toBe(1500);
    expect(r).toMatchObject({ freeShipping: true, shippingDiscountCents: 400 });
  });

  it('un cupón no combinable que no cumple condiciones no bloquea a los demás', () => {
    const noCumple = coupon('MIN500', promo('percent', { percent: 50 }, { priority: 1, conditions: { minSubtotal: '500' } }));
    const extra = coupon('EXTRA5', promo('fixed', { amount: '5' }, { stackable: true }));
    const r = withCoupons([noCumple, extra]);
    expect(r.applied.map((x) => x.couponCode)).toEqual(['EXTRA5']);
    expect(r.rejectedCoupons).toEqual([
      expect.objectContaining({ code: 'MIN500', reason: 'CONDITIONS_NOT_MET', details: { minSubtotal: '500.00', missing: '400.00' } }),
    ]);
  });

  it('dos cupones de la misma promoción: el segundo es DUPLICATE_PROMOTION', () => {
    const p = promo('percent', { percent: 10 }, { stackable: true });
    const a = coupon('AAA', p);
    const b = { promotion: a.promotion, coupon: { ...coupon('BBB', p).coupon } };
    const r = withCoupons([a, b]);
    expect(r.applied).toHaveLength(1);
    expect(r.rejectedCoupons).toEqual([expect.objectContaining({ code: 'BBB', reason: 'DUPLICATE_PROMOTION' })]);
  });

  it('un segundo descuento que ya no tiene sobre qué aplicar se rechaza', () => {
    const todo = coupon('TODO', promo('fixed', { amount: '100' }, { stackable: true }));
    const mas = coupon('MAS', promo('percent', { percent: 10 }, { stackable: true }));
    const r = withCoupons([todo, mas]);
    expect(r.rejectedCoupons).toEqual([expect.objectContaining({ code: 'MAS', reason: 'CONDITIONS_NOT_MET' })]);
  });

  it('el mismo código repetido (con otras mayúsculas) se evalúa una vez', () => {
    const c = coupon('DIEZ', promo('percent', { percent: 10 }));
    const r = run({ couponCodes: ['DIEZ', ' diez '], coupons: [c] });
    expect(r.applied).toHaveLength(1);
    expect(r.rejectedCoupons).toEqual([]);
  });
});

describe('Motor de promociones · límites de uso y vigencia', () => {
  const base = () => promo('percent', { percent: 10 });

  it.each<[string, Partial<PromotionProps>, string]>([
    ['agotó sus usos globales', { maxUses: 100, usedCount: 100 }, 'PROMOTION_USAGE_LIMIT'],
    ['todavía no empieza', { startsAt: new Date('2026-10-01T00:00:00Z') }, 'PROMOTION_NOT_STARTED'],
    ['ya terminó (ends_at exclusivo)', { endsAt: NOW }, 'PROMOTION_EXPIRED'],
    ['está desactivada', { active: false }, 'PROMOTION_NOT_ACTIVE'],
  ])('promoción que %s → %s', (_name, overrides, reason) => {
    const c = coupon('CUPON', { ...base(), ...overrides });
    expect(withCoupons([c]).rejectedCoupons).toEqual([expect.objectContaining({ code: 'CUPON', reason })]);
  });

  it('con un uso disponible, aplica', () => {
    expect(withCoupons([coupon('CUPON', { ...base(), maxUses: 100, usedCount: 99 })]).applied).toHaveLength(1);
  });

  it('cupón que agotó su límite global → COUPON_USAGE_LIMIT', () => {
    const r = withCoupons([coupon('CUPON', base(), { maxUses: 50, usedCount: 50 })]);
    expect(r.rejectedCoupons[0].reason).toBe('COUPON_USAGE_LIMIT');
  });

  it('límite por cliente: 1 uso por defecto', () => {
    const r = withCoupons([coupon('BIENVENIDA', base(), { customerUses: 1 })]);
    expect(r.rejectedCoupons[0]).toMatchObject({ reason: 'COUPON_CUSTOMER_LIMIT', message: 'Ya usaste este cupón' });
  });

  it('límite por cliente mayor a 1', () => {
    expect(withCoupons([coupon('TRES', base(), { maxUsesPerCustomer: 3, customerUses: 2 })]).applied).toHaveLength(1);
    expect(withCoupons([coupon('TRES', base(), { maxUsesPerCustomer: 3, customerUses: 3 })]).rejectedCoupons[0].reason).toBe(
      'COUPON_CUSTOMER_LIMIT',
    );
  });

  it('cupón personal: solo su dueño', () => {
    const c = coupon('SOLOPARATI', base(), { assignedUserId: 'u1' });
    expect(withCoupons([c]).applied).toHaveLength(1);
    expect(withCoupons([c], { userId: 'u2' }).rejectedCoupons[0]).toMatchObject({ reason: 'COUPON_NOT_ASSIGNED' });
    expect(withCoupons([c], { userId: null }).rejectedCoupons[0].message).toMatch(/Inicia sesión/);
  });

  it('código inexistente → COUPON_NOT_FOUND', () => {
    expect(run({ couponCodes: ['NOEXISTE'] }).rejectedCoupons).toEqual([
      { code: 'NOEXISTE', reason: 'COUPON_NOT_FOUND', message: 'El cupón no existe' },
    ]);
  });

  it('una automática agotada o que requiere cupón se ignora sin error', () => {
    const agotada = { ...base(), maxUses: 1, usedCount: 1 };
    const conCupon = { ...base(), requiresCoupon: true };
    const r = run({ automatic: [agotada, conCupon] });
    expect(r.applied).toEqual([]);
    expect(r.rejectedCoupons).toEqual([]);
  });
});
