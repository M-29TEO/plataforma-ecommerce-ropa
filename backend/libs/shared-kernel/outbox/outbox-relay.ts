import { Injectable, Logger } from '@nestjs/common';
import { Counter, metrics } from '@opentelemetry/api';
import { Database } from '../database/database';
import { EventBus, PublishedEvent } from './event-bus';

/** Tras estos intentos fallidos el evento deja de reintentarse (queda para revisión manual). */
export const OUTBOX_MAX_ATTEMPTS = 10;
const DEFAULT_MAX_EVENTS = 500;

interface OutboxRow {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

/**
 * Relay del transactional outbox: toma los eventos sin publicar de platform.outbox_events en
 * orden de id, ejecuta sus consumidores y marca published_at.
 *
 * Cada evento se procesa en SU transacción: los handlers usan las fachadas de los módulos, que
 * se unen a ella (transacción ambiental de Database), así que los efectos de los consumidores y
 * la marca published_at se confirman juntos o no se confirman. Si un handler falla, todo se
 * revierte, se suma un intento y el evento se reintenta en la siguiente pasada.
 *
 * FOR UPDATE SKIP LOCKED permite varias réplicas del worker: dos relays nunca toman el mismo evento.
 *
 * Métricas: outbox.events.published y outbox.events.failed por event_type (en Prometheus
 * outbox_events_published_total{event_type="OrderPlaced"} da los pedidos por minuto).
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly publishedCounter: Counter = metrics.getMeter('moda').createCounter('outbox.events.published', {
    description: 'Eventos de dominio publicados por el relay del outbox',
  });
  private readonly failedCounter: Counter = metrics.getMeter('moda').createCounter('outbox.events.failed', {
    description: 'Intentos fallidos de publicar un evento del outbox',
  });

  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
  ) {}

  /**
   * Publica hasta maxEvents eventos pendientes. Devuelve cuántos publicó y cuántos fallaron.
   * tenantId limita la pasada a un tenant (tests que comparten la base).
   */
  async drain(opts: { maxEvents?: number; tenantId?: string } = {}): Promise<{ published: number; failed: number }> {
    const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    let published = 0;
    let failed = 0;
    const skipped = new Set<string>(); // fallaron en esta pasada: no se reintentan hasta la próxima
    while (published + failed < maxEvents) {
      const outcome = await this.publishNext([...skipped], opts.tenantId ?? null);
      if (outcome === null) break;
      if (outcome.ok) published++;
      else {
        failed++;
        skipped.add(outcome.id);
      }
    }
    return { published, failed };
  }

  private async publishNext(exclude: string[], tenantId: string | null): Promise<{ id: string; ok: boolean } | null> {
    let claimed: PublishedEvent | null = null;
    try {
      const done = await this.db.withTransaction(async (tx) => {
        const { rows } = await tx.query<OutboxRow>(
          `SELECT id, tenant_id, aggregate_type, aggregate_id, event_type, event_version, payload, occurred_at
             FROM platform.outbox_events
            WHERE published_at IS NULL AND attempts < $1 AND NOT (id = ANY($2::bigint[]))
              AND ($3::uuid IS NULL OR tenant_id = $3)
            ORDER BY id
            LIMIT 1
            FOR UPDATE SKIP LOCKED`,
          [OUTBOX_MAX_ATTEMPTS, exclude, tenantId],
        );
        if (rows.length === 0) return false;
        claimed = toEvent(rows[0]);
        for (const { handler } of this.bus.handlersFor(claimed.eventType)) await handler(claimed);
        await tx.query('UPDATE platform.outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = $1', [claimed.id]);
        return true;
      });
      if (!done) return null;
      const event: PublishedEvent = claimed!;
      this.publishedCounter.add(1, { event_type: event.eventType });
      return { id: event.id, ok: true };
    } catch (error) {
      if (!claimed) throw error;
      const event: PublishedEvent = claimed;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Evento ${event.eventType} #${event.id} falló: ${message}`, error instanceof Error ? error.stack : undefined);
      this.failedCounter.add(1, { event_type: event.eventType });
      await this.db.query('UPDATE platform.outbox_events SET attempts = attempts + 1 WHERE id = $1', [event.id]);
      return { id: event.id, ok: false };
    }
  }
}

function toEvent(r: OutboxRow): PublishedEvent {
  return {
    id: String(r.id),
    tenantId: r.tenant_id,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    eventType: r.event_type,
    eventVersion: r.event_version,
    payload: r.payload,
    occurredAt: r.occurred_at,
  };
}
