import { Injectable } from '@nestjs/common';
import { previousRange, ReportKind, ReportQuery, resolveQuery, resolveRange, TIME_GROUPS } from '../domain/report';
import { displayLabel, ReportMetrics, ReportRow, timeBuckets, toMetrics, ZERO_AGGREGATE } from '../domain/report-rows';
import { ReportsReader } from './ports';

export interface ReportResult {
  report: ReportKind;
  groupBy: string;
  from: string;
  to: string;
  /** Las vistas se refrescan cada 15 min: los datos llegan hasta este instante. */
  dataAsOf: string | null;
  rows: ReportRow[];
  totals: ReportMetrics;
}

export interface KpiBlock {
  current: ReportMetrics;
  previous: ReportMetrics;
}

export interface KpiResult {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  dataAsOf: string | null;
  sales: KpiBlock;
  funnel: KpiBlock;
  delivery: KpiBlock;
}

export interface ReportInput {
  from?: string;
  to?: string;
  groupBy?: string;
  limit?: number;
}

/** KPIs del gerente leídos de las vistas materializadas del schema reports. */
@Injectable()
export class ReportQueryService {
  constructor(private readonly reader: ReportsReader) {}

  report(kind: ReportKind, tenantId: string, input: ReportInput, now = new Date()): Promise<ReportResult> {
    return this.run(kind, tenantId, resolveQuery(kind, input, now));
  }

  /** Mismo cálculo que report() con una consulta ya resuelta (la guardada en un exporte). */
  async run(kind: ReportKind, tenantId: string, q: ReportQuery): Promise<ReportResult> {
    const [grouped, totals, asOf] = await Promise.all([
      this.reader.grouped(kind, tenantId, q, q.groupBy, q.limit),
      this.reader.totals(kind, tenantId, q),
      this.reader.dataAsOf(kind),
    ]);
    let rows: ReportRow[] = grouped.map((g) => ({ key: g.key, label: displayLabel(q.groupBy, g.label), ...toMetrics(kind, g.raw) }));
    if ((TIME_GROUPS as readonly string[]).includes(q.groupBy)) {
      const byKey = new Map(rows.map((r) => [r.key, r]));
      rows = timeBuckets(q, q.groupBy as (typeof TIME_GROUPS)[number]).map(
        (key) => byKey.get(key) ?? { key, label: key, ...toMetrics(kind, ZERO_AGGREGATE[kind]) },
      );
    }
    return {
      report: kind,
      groupBy: q.groupBy,
      from: q.from,
      to: q.to,
      dataAsOf: asOf?.toISOString() ?? null,
      rows,
      totals: toMetrics(kind, totals),
    };
  }

  /** Tablero: totales del período y del período anterior del mismo largo. */
  async kpis(tenantId: string, input: { from?: string; to?: string }, now = new Date()): Promise<KpiResult> {
    const range = resolveRange(input, now);
    const prev = previousRange(range);
    const block = async (kind: ReportKind): Promise<KpiBlock> => {
      const [current, previous] = await Promise.all([this.reader.totals(kind, tenantId, range), this.reader.totals(kind, tenantId, prev)]);
      return { current: toMetrics(kind, current), previous: toMetrics(kind, previous) };
    };
    const [sales, funnel, delivery, asOf] = await Promise.all([
      block('sales'),
      block('funnel'),
      block('delivery'),
      this.oldestAsOf(['sales', 'funnel', 'delivery']),
    ]);
    return { from: range.from, to: range.to, previousFrom: prev.from, previousTo: prev.to, dataAsOf: asOf, sales, funnel, delivery };
  }

  private async oldestAsOf(kinds: ReportKind[]): Promise<string | null> {
    const dates = await Promise.all(kinds.map((k) => this.reader.dataAsOf(k)));
    const known = dates.filter((d): d is Date => d !== null).map((d) => d.getTime());
    return known.length ? new Date(Math.min(...known)).toISOString() : null;
  }
}
