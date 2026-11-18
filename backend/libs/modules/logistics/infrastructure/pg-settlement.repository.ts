import { Injectable } from '@nestjs/common';
import { fromCents, Queryable } from '../../../shared-kernel';
import { SettlementFilter, SettlementItemRecord, SettlementRecord, SettlementRepository, SettlementUpdate } from '../application/ports';
import { SettleableDelivery, SettlementDraft, SettlementStatus } from '../domain/settlement';

interface SettlementRow {
  id: string;
  rider_id: string;
  period_start: string;
  period_end: string;
  deliveries_count: number;
  gross_fees: string;
  bonuses: string;
  deductions: string;
  cod_collected: string;
  cod_remitted: string;
  net_payable: string;
  status: SettlementStatus;
  approved_by: string | null;
  paid_at: Date | null;
}

const COLUMNS = `s.id, s.rider_id, s.period_start, s.period_end, s.deliveries_count, s.gross_fees, s.bonuses, s.deductions,
  s.cod_collected, s.cod_remitted, s.net_payable, s.status, s.approved_by, s.paid_at`;

function toRecord(r: SettlementRow): SettlementRecord {
  return {
    id: r.id,
    riderId: r.rider_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    deliveriesCount: r.deliveries_count,
    grossFees: r.gross_fees,
    bonuses: r.bonuses,
    deductions: r.deductions,
    codCollected: r.cod_collected,
    codRemitted: r.cod_remitted,
    netPayable: r.net_payable,
    status: r.status,
    approvedBy: r.approved_by,
    paidAt: r.paid_at,
  };
}

/** Entrega liquidable: con motorizado, completada y fuera de toda liquidación (shipment_id es UNIQUE en los ítems). */
const UNSETTLED = `s.carrier_type = 'rider' AND s.status = 'delivered' AND s.delivered_at < $2
  AND NOT EXISTS (SELECT 1 FROM logistics.rider_settlement_items i WHERE i.shipment_id = s.id)`;

/**
 * rider_settlements no tiene tenant_id: el tenant se toma del motorizado (mismo schema, sin
 * joins entre schemas).
 */
@Injectable()
export class PgSettlementRepository extends SettlementRepository {
  async listRidersToSettle(
    q: Queryable,
    tenantId: string | null,
    period: { start: string; end: string },
    closeAt: Date,
  ): Promise<{ tenantId: string; riderId: string }[]> {
    const { rows } = await q.query<{ tenant_id: string; id: string }>(
      `SELECT r.tenant_id, r.id FROM logistics.riders r
        WHERE ($1::uuid IS NULL OR r.tenant_id = $1)
          AND (EXISTS (SELECT 1 FROM logistics.shipments s WHERE s.rider_id = r.id AND ${UNSETTLED})
               OR EXISTS (SELECT 1 FROM logistics.rider_settlements rs
                           WHERE rs.rider_id = r.id AND rs.period_start = $3 AND rs.period_end = $4)
               OR r.cod_balance > r.cod_limit)
        ORDER BY r.tenant_id, r.id`,
      [tenantId, closeAt, period.start, period.end],
    );
    return rows.map((r) => ({ tenantId: r.tenant_id, riderId: r.id }));
  }

  async findForPeriod(q: Queryable, riderId: string, start: string, end: string): Promise<SettlementRecord | null> {
    const { rows } = await q.query<SettlementRow>(
      `SELECT ${COLUMNS} FROM logistics.rider_settlements s WHERE s.rider_id = $1 AND s.period_start = $2 AND s.period_end = $3`,
      [riderId, start, end],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listUnsettledDeliveries(q: Queryable, riderId: string, closeAt: Date): Promise<SettleableDelivery[]> {
    const { rows } = await q.query<{ id: string; distance_m: number | null; cod_method: string | null; cod_collected: string | null }>(
      `SELECT s.id, s.distance_m, s.cod_method, s.cod_collected FROM logistics.shipments s
        WHERE s.rider_id = $1 AND ${UNSETTLED}
        ORDER BY s.delivered_at, s.id`,
      [riderId, closeAt],
    );
    return rows.map((r) => ({ shipmentId: r.id, distanceM: r.distance_m, codMethod: r.cod_method, codCollected: r.cod_collected }));
  }

  async saveDraft(
    q: Queryable,
    riderId: string,
    period: { start: string; end: string },
    d: SettlementDraft,
    existingId: string | null,
  ): Promise<SettlementRecord> {
    const amounts = [
      d.deliveriesCount,
      fromCents(d.grossFeesCents),
      fromCents(d.bonusesCents),
      fromCents(d.deductionsCents),
      fromCents(d.codCollectedCents),
      fromCents(d.codRemittedCents),
      fromCents(d.netPayableCents),
    ];
    const { rows } = existingId
      ? await q.query<SettlementRow>(
          `UPDATE logistics.rider_settlements s
              SET deliveries_count = $2, gross_fees = $3, bonuses = $4, deductions = $5, cod_collected = $6,
                  cod_remitted = $7, net_payable = $8, status = 'draft', approved_by = NULL, paid_at = NULL
            WHERE s.id = $1 RETURNING ${COLUMNS}`,
          [existingId, ...amounts],
        )
      : await q.query<SettlementRow>(
          `INSERT INTO logistics.rider_settlements AS s
             (rider_id, period_start, period_end, deliveries_count, gross_fees, bonuses, deductions, cod_collected,
              cod_remitted, net_payable, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft') RETURNING ${COLUMNS}`,
          [riderId, period.start, period.end, ...amounts],
        );
    const settlement = toRecord(rows[0]);
    if (d.items.length > 0) {
      await q.query(
        `INSERT INTO logistics.rider_settlement_items (settlement_id, shipment_id, fee, cod_amount)
         SELECT $1, i.shipment_id, i.fee, i.cod_amount
           FROM unnest($2::uuid[], $3::numeric[], $4::numeric[]) AS i(shipment_id, fee, cod_amount)`,
        [settlement.id, d.items.map((i) => i.shipmentId), d.items.map((i) => fromCents(i.feeCents)), d.items.map((i) => fromCents(i.codCents))],
      );
    }
    return settlement;
  }

  async deleteItems(q: Queryable, id: string): Promise<void> {
    await q.query(`DELETE FROM logistics.rider_settlement_items WHERE settlement_id = $1`, [id]);
  }

  async delete(q: Queryable, id: string): Promise<void> {
    await q.query(`DELETE FROM logistics.rider_settlements WHERE id = $1`, [id]);
  }

  async findById(q: Queryable, tenantId: string, id: string, opts: { lock?: boolean } = {}): Promise<SettlementRecord | null> {
    const { rows } = await q.query<SettlementRow>(
      `SELECT ${COLUMNS} FROM logistics.rider_settlements s JOIN logistics.riders r ON r.id = s.rider_id
        WHERE r.tenant_id = $1 AND s.id = $2 ${opts.lock ? 'FOR UPDATE OF s' : ''}`,
      [tenantId, id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listItems(q: Queryable, id: string): Promise<SettlementItemRecord[]> {
    const { rows } = await q.query<{
      shipment_id: string;
      order_id: string;
      delivered_at: Date | null;
      distance_m: number | null;
      cod_method: string | null;
      fee: string;
      cod_amount: string;
    }>(
      `SELECT i.shipment_id, s.order_id, s.delivered_at, s.distance_m, s.cod_method, i.fee, i.cod_amount
         FROM logistics.rider_settlement_items i JOIN logistics.shipments s ON s.id = i.shipment_id
        WHERE i.settlement_id = $1 ORDER BY s.delivered_at, s.id`,
      [id],
    );
    return rows.map((r) => ({
      shipmentId: r.shipment_id,
      orderId: r.order_id,
      deliveredAt: r.delivered_at,
      distanceM: r.distance_m,
      codMethod: r.cod_method,
      fee: r.fee,
      codAmount: r.cod_amount,
    }));
  }

  async list(q: Queryable, tenantId: string, f: SettlementFilter): Promise<SettlementRecord[]> {
    const { rows } = await q.query<SettlementRow>(
      `SELECT ${COLUMNS} FROM logistics.rider_settlements s JOIN logistics.riders r ON r.id = s.rider_id
        WHERE r.tenant_id = $1
          AND ($2::uuid IS NULL OR s.rider_id = $2)
          AND ($3::text IS NULL OR s.status = $3)
          AND ($4::date IS NULL OR s.period_start = $4)
        ORDER BY s.period_start DESC, s.rider_id
        LIMIT $5 OFFSET $6`,
      [tenantId, f.riderId ?? null, f.status ?? null, f.periodStart ?? null, f.limit, f.offset],
    );
    return rows.map(toRecord);
  }

  async update(q: Queryable, id: string, patch: SettlementUpdate): Promise<SettlementRecord> {
    const { rows } = await q.query<SettlementRow>(
      `UPDATE logistics.rider_settlements s
          SET status = $2,
              deductions = COALESCE($3, deductions),
              cod_remitted = COALESCE($4, cod_remitted),
              net_payable = COALESCE($5, net_payable),
              approved_by = COALESCE($6, approved_by),
              paid_at = CASE WHEN $7 THEN now() ELSE paid_at END
        WHERE s.id = $1 RETURNING ${COLUMNS}`,
      [id, patch.status, patch.deductions ?? null, patch.codRemitted ?? null, patch.netPayable ?? null, patch.approvedBy ?? null, patch.paid ?? false],
    );
    return toRecord(rows[0]);
  }
}
