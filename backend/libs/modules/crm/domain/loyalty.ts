import { InvalidTierError } from './errors';

export const LOYALTY_TX_TYPES = ['earn', 'redeem', 'expire', 'adjust', 'referral', 'reversal'] as const;
export type LoyaltyTxType = (typeof LOYALTY_TX_TYPES)[number];
export type LoyaltyTxStatus = 'pending' | 'posted' | 'cancelled';

export interface LoyaltyTier {
  id: string;
  tenantId: string;
  name: string;
  minPoints: number;
  /** numeric(4,2) como string: "1.25". */
  multiplier: string;
  benefits: Record<string, unknown>;
}

export interface LoyaltyAccount {
  userId: string;
  tenantId: string;
  tierId: string | null;
  /** Disponibles para canjear. */
  pointsBalance: number;
  /** Ganados en pedidos que aún están dentro del plazo de devolución. */
  pointsPending: number;
  /** Acreditados en toda la historia (define el nivel; no baja al canjear). */
  lifetimePoints: number;
  updatedAt: Date;
}

export interface LoyaltyTransaction {
  id: string;
  userId: string;
  tenantId: string;
  type: LoyaltyTxType;
  /** Con signo: positivo suma, negativo resta (reversa, canje, ajuste negativo). */
  points: number;
  orderId: string | null;
  reference: string | null;
  status: LoyaltyTxStatus;
  availableAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/** Multiplicador "1.25" → 125 (centésimas) para operar con enteros. */
export function multiplierHundredths(multiplier: string): number {
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(multiplier)) throw new InvalidTierError('multiplier debe tener hasta 2 decimales (por ejemplo 1.25)', 'multiplier');
  const [units, decimals = ''] = multiplier.split('.');
  return Number(units) * 100 + Number(decimals.padEnd(2, '0'));
}

/**
 * Puntos de un pedido: valor de la mercadería (IVA incluido, sin envío) × puntos por dólar ×
 * multiplicador del nivel, hacia abajo (no se regalan fracciones). Todo en enteros.
 */
export function earnPoints(merchandiseCents: number, pointsPerUsd: number, multiplier: string): number {
  if (merchandiseCents <= 0) return 0;
  return Math.floor((merchandiseCents * pointsPerUsd * multiplierHundredths(multiplier)) / 10_000);
}

/**
 * Puntos a revertir por un reembolso: proporcionales al monto reembolsado sobre la base con la
 * que se ganaron, hacia arriba (no se queda con fracciones de lo que devolvió) y nunca más de lo
 * que queda por revertir.
 */
export function reversalPoints(earned: number, alreadyReversed: number, baseCents: number, refundedCents: number): number {
  const remaining = Math.max(0, earned - alreadyReversed);
  if (remaining === 0 || refundedCents <= 0) return 0;
  if (baseCents <= 0 || refundedCents >= baseCents) return remaining;
  return Math.min(remaining, Math.ceil((earned * refundedCents) / baseCents));
}

/** Nivel que corresponde a los puntos históricos: el de mayor mínimo que se alcanzó. */
export function resolveTier<T extends Pick<LoyaltyTier, 'minPoints'>>(tiers: readonly T[], lifetimePoints: number): T | null {
  let best: T | null = null;
  for (const t of tiers) if (t.minPoints <= lifetimePoints && (!best || t.minPoints > best.minPoints)) best = t;
  return best;
}

export function nextTier<T extends Pick<LoyaltyTier, 'minPoints'>>(tiers: readonly T[], lifetimePoints: number): T | null {
  let next: T | null = null;
  for (const t of tiers) if (t.minPoints > lifetimePoints && (!next || t.minPoints < next.minPoints)) next = t;
  return next;
}

/**
 * Los niveles no bajan: si el nivel calculado es menor que el actual (porque un admin subió el
 * mínimo de un nivel), se conserva el actual.
 */
export function promotedTier<T extends Pick<LoyaltyTier, 'id' | 'minPoints'>>(tiers: readonly T[], currentTierId: string | null, lifetimePoints: number): T | null {
  const computed = resolveTier(tiers, lifetimePoints);
  const current = tiers.find((t) => t.id === currentTierId) ?? null;
  if (!computed) return current;
  if (current && current.minPoints >= computed.minPoints) return current;
  return computed;
}

export interface TierInput {
  name?: unknown;
  minPoints?: unknown;
  multiplier?: unknown;
  benefits?: unknown;
}

export function validateTier(input: TierInput, partial = false): Partial<Pick<LoyaltyTier, 'name' | 'minPoints' | 'multiplier' | 'benefits'>> {
  const out: Partial<Pick<LoyaltyTier, 'name' | 'minPoints' | 'multiplier' | 'benefits'>> = {};
  if (input.name !== undefined || !partial) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 2 || name.length > 40) throw new InvalidTierError('name debe tener entre 2 y 40 caracteres', 'name');
    out.name = name;
  }
  if (input.minPoints !== undefined || !partial) {
    if (!Number.isInteger(input.minPoints) || (input.minPoints as number) < 0 || (input.minPoints as number) > 100_000_000) {
      throw new InvalidTierError('minPoints debe ser un entero entre 0 y 100000000', 'minPoints');
    }
    out.minPoints = input.minPoints as number;
  }
  if (input.multiplier !== undefined || !partial) {
    const m = String(input.multiplier ?? '');
    const h = multiplierHundredths(m);
    if (h < 100 || h > 1000) throw new InvalidTierError('multiplier debe estar entre 1.00 y 10.00', 'multiplier');
    out.multiplier = `${Math.floor(h / 100)}.${String(h % 100).padStart(2, '0')}`;
  }
  if (input.benefits !== undefined) {
    if (typeof input.benefits !== 'object' || input.benefits === null || Array.isArray(input.benefits)) {
      throw new InvalidTierError('benefits debe ser un objeto', 'benefits');
    }
    out.benefits = input.benefits as Record<string, unknown>;
  } else if (!partial) out.benefits = {};
  return out;
}

/** Canje de puntos por saldo (gift card): bloques enteros. 100 puntos = 1 USD por defecto. */
export interface RedemptionRules {
  pointsPerUsd: number;
  minPoints: number;
}

export function redemptionValueCents(points: number, rules: RedemptionRules): number {
  return Math.floor((points * 100) / rules.pointsPerUsd);
}
