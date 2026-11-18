import { fromCents, toCents } from '../../../shared-kernel';
import { InvalidPromotionError } from './errors';

/**
 * Tipos de sales.promotions.type. 'gift' (regalo) existe en el modelo de datos pero el motor
 * todavía no lo implementa: se rechaza al crear la promoción.
 */
export const PROMOTION_TYPES = ['percent', 'fixed', 'buy_x_get_y', 'free_shipping', 'tiered'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

/**
 * Alcance: qué líneas del carrito participan. Sin filtros participan todas. Los filtros se
 * combinan con AND entre sí y con OR dentro de cada lista; las exclusiones ganan.
 * categoryPaths incluye subcategorías: 'mujer' abarca 'mujer/vestidos/casual'.
 */
export interface PromotionScope {
  productIds?: string[];
  variantIds?: string[];
  categoryPaths?: string[];
  brandIds?: string[];
  excludeProductIds?: string[];
  excludeVariantIds?: string[];
}

/** sales.promotions.conditions. Los mínimos se miden sobre las líneas del alcance, antes de descuentos. */
export interface PromotionConditions extends PromotionScope {
  /** Monto mínimo "50.00". */
  minSubtotal?: string;
  /** Unidades mínimas. */
  minQuantity?: number;
}

/** Porcentaje sobre las líneas del alcance, con tope opcional. */
export interface PercentBenefit {
  percent: number;
  maxDiscount?: string;
}

/** Monto fijo repartido entre las líneas del alcance (nunca más que su valor). */
export interface FixedBenefit {
  amount: string;
}

/**
 * Lleva buyQuantity + getQuantity y las getQuantity unidades más baratas tienen percentOff
 * de descuento. 2x1 = { buyQuantity: 1, getQuantity: 1, percentOff: 100 };
 * 3x2 = { buyQuantity: 2, getQuantity: 1 }; "segunda al 50 %" = { 1, 1, percentOff: 50 }.
 */
export interface BuyXGetYBenefit {
  buyQuantity: number;
  getQuantity: number;
  percentOff: number;
  /** Máximo de veces que se aplica por pedido. */
  maxApplications?: number;
}

/** Envío gratis (normalmente con conditions.minSubtotal). maxDiscount limita lo que se cubre del envío. */
export interface FreeShippingBenefit {
  maxDiscount?: string;
}

export interface Tier {
  /** Monto ("50.00") si basis = subtotal; unidades si basis = quantity. */
  min: string | number;
  percent?: number;
  amount?: string;
}

/** Escalonado: se aplica el tramo más alto alcanzado. */
export interface TieredBenefit {
  basis: 'subtotal' | 'quantity';
  tiers: Tier[];
}

export type PromotionBenefit = PercentBenefit | FixedBenefit | BuyXGetYBenefit | FreeShippingBenefit | TieredBenefit;

export interface PromotionProps {
  id: string;
  tenantId: string;
  name: string;
  type: PromotionType;
  conditions: PromotionConditions;
  benefit: PromotionBenefit;
  requiresCoupon: boolean;
  /** Combinable con otras promociones combinables. */
  stackable: boolean;
  /** Menor número = se evalúa antes (gana ante una no combinable). */
  priority: number;
  maxUses: number | null;
  usedCount: number;
  startsAt: Date;
  endsAt: Date | null;
  active: boolean;
  createdAt: Date;
}

// ---------------------------------------------------------------------------------------
// Validación de la definición (conditions + benefit en jsonb)
// ---------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const MAX_IDS = 500;

function assertObject(value: unknown, field: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidPromotionError(`${field} debe ser un objeto`, field);
  }
  return value as Json;
}

function assertKnownKeys(obj: Json, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new InvalidPromotionError(`${field} tiene campos desconocidos: ${unknown.join(', ')}`, field);
}

function money(value: unknown, field: string, opts: { positive?: boolean } = {}): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new InvalidPromotionError(`${field} debe ser un monto`, field);
  }
  let cents: number;
  try {
    cents = toCents(value);
  } catch {
    throw new InvalidPromotionError(`${field} debe ser un monto con máximo 2 decimales`, field);
  }
  if (opts.positive && cents <= 0) throw new InvalidPromotionError(`${field} debe ser mayor que 0`, field);
  return fromCents(cents);
}

function int(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidPromotionError(`${field} debe ser un entero entre ${min} y ${max}`, field);
  }
  return value;
}

/** Porcentaje con máximo 2 decimales, en (0, 100]. */
function percent(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw new InvalidPromotionError(`${field} debe ser un porcentaje mayor que 0 y hasta 100`, field);
  }
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-9) {
    throw new InvalidPromotionError(`${field} admite máximo 2 decimales`, field);
  }
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IDS) {
    throw new InvalidPromotionError(`${field} debe ser una lista de 1 a ${MAX_IDS} elementos`, field);
  }
  const clean = value.map((v) => {
    if (typeof v !== 'string' || !v.trim()) throw new InvalidPromotionError(`${field} solo admite textos`, field);
    return v.trim();
  });
  return [...new Set(clean)];
}

const SCOPE_KEYS = ['productIds', 'variantIds', 'categoryPaths', 'brandIds', 'excludeProductIds', 'excludeVariantIds'] as const;

function validateConditions(raw: unknown): PromotionConditions {
  const obj = assertObject(raw ?? {}, 'conditions');
  assertKnownKeys(obj, [...SCOPE_KEYS, 'minSubtotal', 'minQuantity'], 'conditions');
  const out: PromotionConditions = {};
  for (const key of SCOPE_KEYS) {
    if (obj[key] !== undefined) out[key] = stringList(obj[key], `conditions.${key}`);
  }
  if (out.categoryPaths) {
    out.categoryPaths = [...new Set(out.categoryPaths.map((p) => p.replace(/^\/+|\/+$/g, '').toLowerCase()))];
  }
  if (obj.minSubtotal !== undefined) out.minSubtotal = money(obj.minSubtotal, 'conditions.minSubtotal', { positive: true });
  if (obj.minQuantity !== undefined) out.minQuantity = int(obj.minQuantity, 'conditions.minQuantity', 1, 1000);
  return out;
}

function validateBenefit(type: PromotionType, raw: unknown): PromotionBenefit {
  const b = assertObject(raw ?? {}, 'benefit');
  switch (type) {
    case 'percent': {
      assertKnownKeys(b, ['percent', 'maxDiscount'], 'benefit');
      const out: PercentBenefit = { percent: percent(b.percent, 'benefit.percent') };
      if (b.maxDiscount !== undefined) out.maxDiscount = money(b.maxDiscount, 'benefit.maxDiscount', { positive: true });
      return out;
    }
    case 'fixed':
      assertKnownKeys(b, ['amount'], 'benefit');
      return { amount: money(b.amount, 'benefit.amount', { positive: true }) } satisfies FixedBenefit;
    case 'buy_x_get_y': {
      assertKnownKeys(b, ['buyQuantity', 'getQuantity', 'percentOff', 'maxApplications'], 'benefit');
      const out: BuyXGetYBenefit = {
        buyQuantity: int(b.buyQuantity, 'benefit.buyQuantity', 1, 100),
        getQuantity: int(b.getQuantity, 'benefit.getQuantity', 1, 100),
        percentOff: b.percentOff === undefined ? 100 : percent(b.percentOff, 'benefit.percentOff'),
      };
      if (b.maxApplications !== undefined) out.maxApplications = int(b.maxApplications, 'benefit.maxApplications', 1, 1000);
      return out;
    }
    case 'free_shipping': {
      assertKnownKeys(b, ['maxDiscount'], 'benefit');
      const out: FreeShippingBenefit = {};
      if (b.maxDiscount !== undefined) out.maxDiscount = money(b.maxDiscount, 'benefit.maxDiscount', { positive: true });
      return out;
    }
    case 'tiered': {
      assertKnownKeys(b, ['basis', 'tiers'], 'benefit');
      if (b.basis !== 'subtotal' && b.basis !== 'quantity') {
        throw new InvalidPromotionError('benefit.basis debe ser "subtotal" o "quantity"', 'benefit.basis');
      }
      const basis = b.basis;
      if (!Array.isArray(b.tiers) || b.tiers.length === 0 || b.tiers.length > 20) {
        throw new InvalidPromotionError('benefit.tiers debe tener de 1 a 20 tramos', 'benefit.tiers');
      }
      const tiers = b.tiers.map((rawTier, i): Tier => {
        const field = `benefit.tiers[${i}]`;
        const t = assertObject(rawTier, field);
        assertKnownKeys(t, ['min', 'percent', 'amount'], field);
        if ((t.percent === undefined) === (t.amount === undefined)) {
          throw new InvalidPromotionError(`${field} debe tener percent o amount (solo uno)`, field);
        }
        const min = basis === 'subtotal' ? money(t.min, `${field}.min`, { positive: true }) : int(t.min, `${field}.min`, 1, 1000);
        return t.percent !== undefined
          ? { min, percent: percent(t.percent, `${field}.percent`) }
          : { min, amount: money(t.amount, `${field}.amount`, { positive: true }) };
      });
      const measure = (t: Tier) => (basis === 'subtotal' ? toCents(t.min as string) : (t.min as number));
      tiers.sort((x, y) => measure(x) - measure(y));
      for (let i = 1; i < tiers.length; i++) {
        if (measure(tiers[i]) === measure(tiers[i - 1])) {
          throw new InvalidPromotionError('Dos tramos no pueden tener el mismo mínimo', 'benefit.tiers');
        }
      }
      return { basis, tiers } satisfies TieredBenefit;
    }
  }
}

export interface PromotionDefinitionInput {
  type: string;
  conditions?: unknown;
  benefit: unknown;
}

/** Valida y normaliza conditions y benefit según el tipo. Lanza InvalidPromotionError. */
export function validatePromotionDefinition(input: PromotionDefinitionInput): {
  type: PromotionType;
  conditions: PromotionConditions;
  benefit: PromotionBenefit;
} {
  if (!(PROMOTION_TYPES as readonly string[]).includes(input.type)) {
    throw new InvalidPromotionError(`Tipo de promoción no soportado: "${input.type}"`, 'type');
  }
  const type = input.type as PromotionType;
  return { type, conditions: validateConditions(input.conditions), benefit: validateBenefit(type, input.benefit) };
}

export function validatePromotionWindow(startsAt: Date, endsAt: Date | null): void {
  if (Number.isNaN(startsAt.getTime())) throw new InvalidPromotionError('startsAt inválido', 'startsAt');
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw new InvalidPromotionError('endsAt debe ser posterior a startsAt', 'endsAt');
  }
}

export function validatePromotionName(name: string): string {
  const clean = name?.trim();
  if (!clean || clean.length > 200) throw new InvalidPromotionError('El nombre debe tener de 1 a 200 caracteres', 'name');
  return clean;
}

// ---------------------------------------------------------------------------------------
// Cupones
// ---------------------------------------------------------------------------------------

const COUPON_RE = /^[A-Z0-9_-]{3,40}$/;

/** Los códigos son citext en la base (sin distinción de mayúsculas); se muestran en mayúsculas. */
export function normalizeCouponCode(code: string): string {
  return (code ?? '').trim().toUpperCase();
}

export function isValidCouponCode(code: string): boolean {
  return COUPON_RE.test(normalizeCouponCode(code));
}

export interface CouponProps {
  id: string;
  promotionId: string;
  tenantId: string;
  code: string;
  maxUses: number | null;
  maxUsesPerCustomer: number;
  usedCount: number;
  assignedUserId: string | null;
}

/**
 * Claves con las que se cuentan los usos por cliente (sales.promotion_redemptions.customer_key).
 * La primera es la que se guarda al canjear; se consultan todas, así un cliente que compró
 * como invitado con su email no vuelve a usar el cupón después de registrarse.
 */
export function customerKeysFor(userId: string | null, email: string | null): string[] {
  const keys: string[] = [];
  if (userId) keys.push(`user:${userId}`);
  const cleanEmail = email?.trim().toLowerCase();
  if (cleanEmail) keys.push(`email:${cleanEmail}`);
  return keys;
}
