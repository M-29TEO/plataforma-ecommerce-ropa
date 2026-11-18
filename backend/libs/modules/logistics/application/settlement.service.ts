import { Injectable, Logger } from '@nestjs/common';
import { Database, DomainError, fromCents, OutboxWriter, Queryable, toCents } from '../../../shared-kernel';
import { parseCommissionScheme } from '../domain/commission';
import { RiderNotFoundError, SettlementNotFoundError } from '../domain/errors';
import {
  RIDER_SETTLEMENT_APPROVED,
  RIDER_SETTLEMENT_DISPUTED,
  RIDER_SETTLEMENT_DRAFTED,
  RIDER_SETTLEMENT_PAID,
  riderCodLimitExceeded,
  riderSettlementEvent,
  RiderSettlementPayload,
} from '../domain/events';
import {
  assertDifferentPayer,
  assertSettlementTransition,
  codControl,
  CodControl,
  computeApproval,
  computeDraft,
  periodCloseAt,
  periodStartingOn,
  previousWeek,
  REBUILDABLE,
  SettlementPeriod,
  SettlementStatus,
} from '../domain/settlement';
import { RiderRecord, RiderRepository, SettlementFilter, SettlementItemRecord, SettlementRecord, SettlementRepository } from './ports';

export interface GenerateSettlementsInput {
  /** null = todos los tenants (job semanal). */
  tenantId: string | null;
  /** Lunes del período; por defecto, la semana anterior. */
  periodStart?: string;
  /** El backoffice puede recalcular también las liquidaciones en disputa (el job nunca lo hace). */
  rebuildDisputed?: boolean;
  now?: Date;
}

export interface GenerateSettlementsResult {
  period: SettlementPeriod;
  created: number;
  updated: number;
  removed: number;
  /** Ya aprobadas, pagadas (o en disputa): no se tocan. */
  skipped: number;
  codLimitExceeded: string[];
  failed: { riderId: string; code: string; message: string }[];
}

export interface SettlementDetail extends SettlementRecord {
  items: SettlementItemRecord[];
  cod: CodControl;
}

export type SettlementActor = { type: 'staff'; id: string } | { type: 'rider'; id: string; riderId: string };

type RiderOutcome = 'created' | 'updated' | 'removed' | 'skipped' | 'none';

function payload(s: SettlementRecord): RiderSettlementPayload {
  const { approvedBy: _a, paidAt: _p, id, ...rest } = s;
  return { settlementId: id, ...rest };
}

/**
 * Liquidaciones semanales de motorizados (SettlementService del C4). Cada motorizado se
 * liquida en su propia transacción con su fila bloqueada (FOR UPDATE): el job, una generación
 * manual, una aprobación y una calificación del mismo motorizado se serializan, y un error en
 * uno (p. ej. commission_scheme inválido) no frena al resto.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly db: Database,
    private readonly settlements: SettlementRepository,
    private readonly riders: RiderRepository,
    private readonly outbox: OutboxWriter,
  ) {}

  /** Job semanal (todos los tenants) o botón del backoffice (un tenant). Idempotente: recalcula los borradores. */
  async generate(input: GenerateSettlementsInput): Promise<GenerateSettlementsResult> {
    const now = input.now ?? new Date();
    const period = input.periodStart ? periodStartingOn(input.periodStart, now) : previousWeek(now);
    const closeAt = periodCloseAt(period);
    const rebuildable: SettlementStatus[] = input.rebuildDisputed ? [...REBUILDABLE, 'disputed'] : [...REBUILDABLE];
    const result: GenerateSettlementsResult = { period, created: 0, updated: 0, removed: 0, skipped: 0, codLimitExceeded: [], failed: [] };

    for (const r of await this.settlements.listRidersToSettle(this.db, input.tenantId, period, closeAt)) {
      try {
        const { outcome, overLimit } = await this.settleRider(r.tenantId, r.riderId, period, closeAt, rebuildable, now);
        if (outcome !== 'none') result[outcome]++;
        if (overLimit) result.codLimitExceeded.push(r.riderId);
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
        this.logger.warn(`No se pudo liquidar al motorizado ${r.riderId}: ${e.code} ${e.message}`);
        result.failed.push({ riderId: r.riderId, code: e.code, message: e.message });
      }
    }
    return result;
  }

  private settleRider(
    tenantId: string,
    riderId: string,
    period: SettlementPeriod,
    closeAt: Date,
    rebuildable: SettlementStatus[],
    now: Date,
  ): Promise<{ outcome: RiderOutcome; overLimit: boolean }> {
    return this.db.withTransaction(async (tx) => {
      const rider = await this.riders.lock(tx, riderId);
      if (!rider) return { outcome: 'none' as const, overLimit: false };
      const outcome = await this.rebuildDraft(tx, tenantId, rider, period, closeAt, rebuildable);

      const cod = codControl(rider.codBalance, rider.codLimit);
      if (cod.overLimit) {
        await this.outbox.append(tx, [
          riderCodLimitExceeded(tenantId, { riderId, codBalance: cod.codBalance, codLimit: cod.codLimit, detectedAt: now.toISOString() }),
        ]);
      }
      return { outcome, overLimit: cod.overLimit };
    });
  }

  private async rebuildDraft(
    tx: Queryable,
    tenantId: string,
    rider: RiderRecord,
    period: SettlementPeriod,
    closeAt: Date,
    rebuildable: SettlementStatus[],
  ): Promise<RiderOutcome> {
    const existing = await this.settlements.findForPeriod(tx, rider.id, period.start, period.end);
    if (existing && !rebuildable.includes(existing.status)) return 'skipped';
    // Se sueltan los ítems del borrador para que vuelvan a entrar (con entregas tardías y el esquema vigente).
    if (existing) await this.settlements.deleteItems(tx, existing.id);

    const deliveries = await this.settlements.listUnsettledDeliveries(tx, rider.id, closeAt);
    if (deliveries.length === 0) {
      if (!existing) return 'none';
      await this.settlements.delete(tx, existing.id);
      return 'removed';
    }
    const draft = computeDraft(parseCommissionScheme(rider.commissionScheme), deliveries, toCents(rider.codBalance));
    const saved = await this.settlements.saveDraft(tx, rider.id, period, draft, existing?.id ?? null);
    await this.outbox.append(tx, [riderSettlementEvent(tenantId, RIDER_SETTLEMENT_DRAFTED, { ...payload(saved) })]);
    return existing ? 'updated' : 'created';
  }

  // ---------------------------------------------------------------- Consultas
  list(tenantId: string, filter: SettlementFilter): Promise<SettlementRecord[]> {
    return this.settlements.list(this.db, tenantId, filter);
  }

  async get(tenantId: string, id: string, riderId?: string): Promise<SettlementDetail> {
    const s = await this.find(this.db, tenantId, id, riderId);
    const rider = await this.riders.findById(this.db, tenantId, s.riderId);
    return { ...s, items: await this.settlements.listItems(this.db, id), cod: codControl(rider!.codBalance, rider!.codLimit) };
  }

  /** Motorizado autenticado → su id (las rutas /rider solo ven lo propio). */
  async riderIdForUser(tenantId: string, userId: string): Promise<string> {
    const rider = await this.riders.findByUser(this.db, tenantId, userId);
    if (!rider) throw new RiderNotFoundError(userId);
    return rider.id;
  }

  // ---------------------------------------------------------------- Aprobación en backoffice
  /**
   * draft|disputed → approved. El backoffice registra el efectivo que el motorizado entregó
   * (codRemitted); el resto de su cod_balance se retiene de lo que se le paga y lo que no alcance
   * queda como saldo para la próxima semana.
   */
  approve(tenantId: string, id: string, approvedBy: string, codRemitted: string) {
    return this.transition(tenantId, id, 'approved', async (tx, s, rider) => {
      const amounts = computeApproval({
        grossFeesCents: toCents(s.grossFees),
        bonusesCents: toCents(s.bonuses),
        codBalanceCents: toCents(rider.codBalance),
        codRemittedCents: toCents(codRemitted),
      });
      const updated = await this.settlements.update(tx, id, {
        status: 'approved',
        codRemitted: fromCents(toCents(codRemitted)),
        deductions: fromCents(amounts.deductionsCents),
        netPayable: fromCents(amounts.netPayableCents),
        approvedBy,
      });
      const codBalance = fromCents(amounts.codBalanceAfterCents);
      await this.riders.setCodBalance(tx, rider.id, codBalance);
      return { updated, eventType: RIDER_SETTLEMENT_APPROVED, extra: { approvedBy, codBalanceBefore: rider.codBalance, codBalanceAfter: codBalance } };
    });
  }

  /** draft → disputed (el motorizado o el backoffice no están de acuerdo). El motivo viaja en el evento. */
  dispute(tenantId: string, id: string, reason: string, actor: SettlementActor) {
    const riderScope = actor.type === 'rider' ? actor.riderId : undefined;
    return this.transition(
      tenantId,
      id,
      'disputed',
      async (tx) => ({
        updated: await this.settlements.update(tx, id, { status: 'disputed' }),
        eventType: RIDER_SETTLEMENT_DISPUTED,
        extra: { reason, disputedBy: { type: actor.type, id: actor.id } },
      }),
      riderScope,
    );
  }

  /** approved → paid (transferencia hecha fuera del sistema). Lo marca alguien distinto de quien aprobó. */
  markPaid(tenantId: string, id: string, paidBy: string) {
    return this.transition(tenantId, id, 'paid', async (tx, s) => {
      assertDifferentPayer(id, s.approvedBy, paidBy);
      return {
        updated: await this.settlements.update(tx, id, { status: 'paid', paid: true }),
        eventType: RIDER_SETTLEMENT_PAID,
        extra: { paidBy },
      };
    });
  }

  /** Bloquea motorizado → liquidación (mismo orden que el job), valida la transición y emite el evento. */
  private async transition(
    tenantId: string,
    id: string,
    to: SettlementStatus,
    apply: (
      tx: Queryable,
      s: SettlementRecord,
      rider: RiderRecord,
    ) => Promise<{ updated: SettlementRecord; eventType: string; extra: Record<string, unknown> }>,
    riderScope?: string,
  ): Promise<SettlementDetail> {
    const current = await this.find(this.db, tenantId, id, riderScope);
    await this.db.withTransaction(async (tx) => {
      const rider = (await this.riders.lock(tx, current.riderId))!;
      const s = (await this.settlements.findById(tx, tenantId, id, { lock: true }))!;
      assertSettlementTransition(id, s.status, to);
      const { updated, eventType, extra } = await apply(tx, s, rider);
      await this.outbox.append(tx, [riderSettlementEvent(tenantId, eventType, { ...payload(updated), ...extra })]);
    });
    return this.get(tenantId, id);
  }

  private async find(q: Queryable, tenantId: string, id: string, riderId?: string): Promise<SettlementRecord> {
    const s = await this.settlements.findById(q, tenantId, id);
    if (!s || (riderId && s.riderId !== riderId)) throw new SettlementNotFoundError(id);
    return s;
  }
}
