import { ConflictError, fromCents, toCents, ValidationError } from '../../../shared-kernel';
import { CommissionScheme, deliveryFeeCents, volumeBonusCents } from './commission';
import { addDays, localDate, localInstant, weekdayOf } from './slot';

/**
 * Liquidación semanal del motorizado (logistics.rider_settlements + rider_settlement_items).
 *
 *   draft ──approve──▶ approved ──mark-paid──▶ paid
 *     │                   ▲
 *     └──dispute──▶ disputed
 *
 * Efectivo contra entrega: riders.cod_balance es el efectivo que el motorizado tiene en mano y
 * todavía no rindió (lo suma la entrega en efectivo; lo baja la aprobación de una liquidación).
 * Al aprobar, el backoffice registra cuánto efectivo entregó (cod_remitted); lo que falte se
 * RETIENE de sus comisiones (deductions) y lo que no alcance a cubrirse queda en cod_balance.
 */
export const SETTLEMENT_STATUSES = ['draft', 'approved', 'paid', 'disputed'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/** Estados que la generación puede recalcular (borrar sus ítems y volver a armarlos). */
export const REBUILDABLE: readonly SettlementStatus[] = ['draft'];

// ---------------------------------------------------------------- Período (semana lunes-domingo, hora local)
export interface SettlementPeriod {
  /** Lunes, 'AAAA-MM-DD' (America/Guayaquil). */
  start: string;
  /** Domingo, inclusive. */
  end: string;
}

export function weekContaining(date: string): SettlementPeriod {
  const monday = addDays(date, -((weekdayOf(date) + 6) % 7));
  return { start: monday, end: addDays(monday, 6) };
}

/** Semana anterior a la de `now` (la que cierra el job de los lunes). */
export function previousWeek(now: Date): SettlementPeriod {
  return weekContaining(addDays(localDate(now), -7));
}

/** Instante de cierre: lunes siguiente a las 00:00 locales. Entra lo entregado ANTES de ese instante. */
export function periodCloseAt(p: SettlementPeriod): Date {
  return localInstant(addDays(p.end, 1), '00:00');
}

export function periodStartingOn(start: string, now: Date): SettlementPeriod {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(`${start}T12:00:00Z`))) {
    throw new ValidationError('INVALID_SETTLEMENT_PERIOD', 'periodStart debe ser una fecha AAAA-MM-DD', { periodStart: start });
  }
  if (weekdayOf(start) !== 1) {
    throw new ValidationError('INVALID_SETTLEMENT_PERIOD', 'El período de liquidación empieza un lunes', { periodStart: start });
  }
  const period = weekContaining(start);
  if (periodCloseAt(period) > now) {
    throw new ValidationError('SETTLEMENT_PERIOD_NOT_CLOSED', 'La semana todavía no termina', { ...period });
  }
  return period;
}

// ---------------------------------------------------------------- Cálculo del borrador
export interface SettleableDelivery {
  shipmentId: string;
  distanceM: number | null;
  codMethod: string | null;
  codCollected: string | null;
}

export interface DraftItem {
  shipmentId: string;
  feeCents: number;
  /** Efectivo cobrado en esa entrega (card_pos y deuna_qr no pasan por las manos del motorizado). */
  codCents: number;
}

export interface SettlementAmounts {
  deliveriesCount: number;
  grossFeesCents: number;
  bonusesCents: number;
  deductionsCents: number;
  codCollectedCents: number;
  codRemittedCents: number;
  netPayableCents: number;
}

export interface SettlementDraft extends SettlementAmounts {
  items: DraftItem[];
}

export function cashCents(d: Pick<SettleableDelivery, 'codMethod' | 'codCollected'>): number {
  return d.codMethod === 'cash' && d.codCollected ? toCents(d.codCollected) : 0;
}

/** Efectivo que se retiene de las comisiones: lo que aún debe, sin pasar de lo que se le paga. */
export function cashWithholdingCents(codBalanceCents: number, codRemittedCents: number, payableCents: number): number {
  return Math.min(Math.max(codBalanceCents - codRemittedCents, 0), Math.max(payableCents, 0));
}

/**
 * Borrador: comisiones por entrega + bono por volumen. La retención (deductions) es una PROPUESTA
 * con el cod_balance actual y cod_remitted = 0; se recalcula al aprobar con el efectivo recibido.
 */
export function computeDraft(scheme: CommissionScheme, deliveries: SettleableDelivery[], codBalanceCents: number): SettlementDraft {
  const items = deliveries.map((d) => ({ shipmentId: d.shipmentId, feeCents: deliveryFeeCents(scheme, d.distanceM), codCents: cashCents(d) }));
  const grossFeesCents = items.reduce((sum, i) => sum + i.feeCents, 0);
  const bonusesCents = volumeBonusCents(scheme, items.length);
  const deductionsCents = cashWithholdingCents(codBalanceCents, 0, grossFeesCents + bonusesCents);
  return {
    items,
    deliveriesCount: items.length,
    grossFeesCents,
    bonusesCents,
    deductionsCents,
    codCollectedCents: items.reduce((sum, i) => sum + i.codCents, 0),
    codRemittedCents: 0,
    netPayableCents: grossFeesCents + bonusesCents - deductionsCents,
  };
}

// ---------------------------------------------------------------- Aprobación
export class CodRemittedExceedsBalanceError extends ValidationError {
  constructor(remitted: string, balance: string) {
    super('COD_REMITTED_EXCEEDS_BALANCE', 'El efectivo rendido no puede superar el saldo de efectivo del motorizado', {
      codRemitted: remitted,
      codBalance: balance,
    });
  }
}

export interface ApprovalAmounts {
  deductionsCents: number;
  netPayableCents: number;
  codBalanceAfterCents: number;
}

export function computeApproval(input: {
  grossFeesCents: number;
  bonusesCents: number;
  codBalanceCents: number;
  codRemittedCents: number;
}): ApprovalAmounts {
  const { grossFeesCents, bonusesCents, codBalanceCents, codRemittedCents } = input;
  if (codRemittedCents > codBalanceCents) {
    throw new CodRemittedExceedsBalanceError(fromCents(codRemittedCents), fromCents(codBalanceCents));
  }
  const deductionsCents = cashWithholdingCents(codBalanceCents, codRemittedCents, grossFeesCents + bonusesCents);
  return {
    deductionsCents,
    netPayableCents: grossFeesCents + bonusesCents - deductionsCents,
    codBalanceAfterCents: codBalanceCents - codRemittedCents - deductionsCents,
  };
}

// ---------------------------------------------------------------- Transiciones
const TRANSITIONS: Record<SettlementStatus, readonly SettlementStatus[]> = {
  draft: ['approved', 'disputed'],
  disputed: ['approved'],
  approved: ['paid'],
  paid: [],
};

export class InvalidSettlementTransitionError extends ConflictError {
  constructor(id: string, from: string, to: SettlementStatus) {
    super('INVALID_SETTLEMENT_TRANSITION', `Una liquidación en estado ${from} no puede pasar a ${to}`, { id, from, to });
  }
}

/** Estados desde los que se puede llegar a `to`. */
export function allowedFrom(to: SettlementStatus): SettlementStatus[] {
  return SETTLEMENT_STATUSES.filter((s) => TRANSITIONS[s].includes(to));
}

export function assertSettlementTransition(id: string, from: string, to: SettlementStatus): void {
  if (!(TRANSITIONS[from as SettlementStatus] ?? []).includes(to)) throw new InvalidSettlementTransitionError(id, from, to);
}

/**
 * Segregación de funciones: aprobar y marcar pagada usan el mismo permiso, pero no puede hacerlo
 * la misma persona; si no, un solo usuario fija el monto y da por hecha la transferencia.
 */
export class SettlementSameApproverError extends ConflictError {
  constructor(id: string) {
    super('SETTLEMENT_SAME_APPROVER', 'Quien aprobó la liquidación no puede marcarla como pagada', { id });
  }
}

export function assertDifferentPayer(id: string, approvedBy: string | null, paidBy: string): void {
  if (approvedBy !== null && approvedBy === paidBy) throw new SettlementSameApproverError(id);
}

// ---------------------------------------------------------------- Control de efectivo
export interface CodControl {
  codBalance: string;
  codLimit: string;
  /** Cuánto efectivo más puede recibir antes de llegar al límite. */
  codAvailable: string;
  overLimit: boolean;
}

export function codControl(codBalance: string, codLimit: string): CodControl {
  const balance = toCents(codBalance);
  const limit = toCents(codLimit);
  return { codBalance, codLimit, codAvailable: fromCents(Math.max(limit - balance, 0)), overLimit: balance > limit };
}
