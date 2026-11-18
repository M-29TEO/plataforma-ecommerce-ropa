import { Injectable } from '@nestjs/common';
import { Queryable } from '../database/database';

export interface DomainEvent<P extends object = Record<string, unknown>> {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion?: number;
  payload: P;
}

/**
 * Transactional outbox: el evento se inserta en platform.outbox_events con el MISMO
 * cliente de la transacción que cambia el estado. Si la transacción hace ROLLBACK,
 * el evento desaparece con ella; si hace COMMIT, el relay lo publicará.
 */
@Injectable()
export class OutboxWriter {
  async append(tx: Queryable, events: DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    const values: unknown[] = [];
    const rows = events.map((e, i) => {
      const o = i * 6;
      values.push(e.tenantId, e.aggregateType, e.aggregateId, e.eventType, e.eventVersion ?? 1, JSON.stringify(e.payload));
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}::jsonb)`;
    });
    await tx.query(
      `INSERT INTO platform.outbox_events
         (tenant_id, aggregate_type, aggregate_id, event_type, event_version, payload)
       VALUES ${rows.join(', ')}`,
      values,
    );
  }
}
