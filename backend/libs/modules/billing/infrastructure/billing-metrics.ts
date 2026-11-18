import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BatchObservableCallback, Meter, metrics, Observable } from '@opentelemetry/api';
import { Database } from '../../../shared-kernel';
import { IN_PROGRESS } from '../domain/electronic-document';

const REJECTED = ['returned', 'not_authorized'];

export interface PendingRow {
  status: string;
  doc_type: string;
  count: number;
  oldest_age_seconds: number;
}

/**
 * Métricas de Facturación para el dashboard y las alertas (proceso worker, cada exportación del SDK):
 *  - sri.documents.pending{status,doc_type}: comprobantes que todavía esperan al SRI
 *    (pending, signed, sent, received).
 *  - sri.documents.pending.oldest_age (s): antigüedad del pendiente más viejo; si crece, el SRI
 *    (o el job) no está avanzando.
 *  - sri.documents.rejected{status,doc_type}: devueltos o no autorizados en las últimas 24 h.
 * Lee solo su schema (billing) y no por tenant: es una vista de operación de toda la plataforma.
 */
@Injectable()
export class BillingMetrics implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingMetrics.name);
  private meter?: Meter;
  private gauges: Observable[] = [];
  private callback?: BatchObservableCallback;

  constructor(private readonly db: Database) {}

  onModuleInit(): void {
    const meter = metrics.getMeter('moda');
    const pending = meter.createObservableGauge('sri.documents.pending', { description: 'Comprobantes electrónicos pendientes con el SRI', unit: '{document}' });
    const oldest = meter.createObservableGauge('sri.documents.pending.oldest_age', { description: 'Antigüedad del comprobante pendiente más viejo', unit: 's' });
    const rejected = meter.createObservableGauge('sri.documents.rejected', { description: 'Comprobantes devueltos o no autorizados en las últimas 24 h', unit: '{document}' });
    this.callback = async (result) => {
      try {
        const rows = await this.summary();
        let maxAge = 0;
        for (const r of rows) {
          const attrs = { status: r.status, doc_type: r.doc_type };
          if (REJECTED.includes(r.status)) result.observe(rejected, r.count, attrs);
          else {
            result.observe(pending, r.count, attrs);
            maxAge = Math.max(maxAge, r.oldest_age_seconds);
          }
        }
        // Siempre hay una serie: 0 si no hay pendientes (así la alerta no queda "sin datos").
        result.observe(oldest, maxAge);
        if (!rows.some((r) => !REJECTED.includes(r.status))) result.observe(pending, 0, { status: 'pending', doc_type: '01' });
      } catch (e) {
        this.logger.warn(`No se pudieron leer los comprobantes pendientes: ${(e as Error).message}`);
      }
    };
    this.gauges = [pending, oldest, rejected];
    this.meter = meter;
    meter.addBatchObservableCallback(this.callback, this.gauges);
  }

  onModuleDestroy(): void {
    if (this.meter && this.callback) this.meter.removeBatchObservableCallback(this.callback, this.gauges);
  }

  /** Conteo y antigüedad por estado y tipo: los en curso y los rechazados de las últimas 24 h. */
  async summary(): Promise<PendingRow[]> {
    const { rows } = await this.db.query<{ status: string; doc_type: string; count: string; oldest_age_seconds: string }>(
      `SELECT status, doc_type, count(*) AS count,
              coalesce(extract(epoch FROM now() - min(created_at)), 0) AS oldest_age_seconds
         FROM billing.electronic_documents
        WHERE status = ANY($1::text[])
           OR (status = ANY($2::text[]) AND created_at > now() - interval '24 hours')
        GROUP BY status, doc_type`,
      [IN_PROGRESS, REJECTED],
    );
    return rows.map((r) => ({ status: r.status, doc_type: r.doc_type.trim(), count: Number(r.count), oldest_age_seconds: Math.round(Number(r.oldest_age_seconds)) }));
  }
}
