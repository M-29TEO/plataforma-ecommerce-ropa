import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, DomainEvent, OutboxWriter } from '../../../shared-kernel';
import { ticketSlaBreached } from '../domain/events';
import { TicketRepository } from './ports';
import { TicketService } from './ticket.service';

export interface SweepRun {
  /** Tickets cuyo SLA venció en esta pasada (se alertaron). */
  breached: number;
  /** Tickets resueltos que se cerraron solos (se envió la encuesta). */
  autoClosed: number;
  /** true si algún lote se llenó: queda trabajo para otra pasada. */
  more: boolean;
}

/**
 * Pasada del job de soporte: (1) marca y alerta los SLA vencidos (TicketSlaBreached → ntfy del
 * backoffice), una sola vez por ticket gracias a sla_breached_at; (2) cierra los tickets resueltos
 * hace más de SUPPORT_AUTO_CLOSE_DAYS (TicketClosed → encuesta CSAT). Las filas se toman con
 * FOR UPDATE SKIP LOCKED: dos réplicas del worker no procesan el mismo ticket.
 */
@Injectable()
export class SlaMonitorService {
  constructor(
    private readonly db: Database,
    private readonly tickets: TicketRepository,
    private readonly outbox: OutboxWriter,
    private readonly service: TicketService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sweep(now = new Date(), limit = 50, tenantId?: string): Promise<SweepRun> {
    const breached = await this.db.withTransaction(async (tx) => {
      const due = await this.tickets.lockSlaBreached(tx, now, limit, tenantId);
      const events: DomainEvent[] = [];
      for (const t of due) {
        const version = t.version;
        if (!t.markSlaBreached(now)) continue;
        if (!(await this.tickets.update(tx, t, version))) continue;
        await this.tickets.insertMessages(tx, t);
        events.push(ticketSlaBreached(t.toJSON()));
      }
      await this.outbox.append(tx, events);
      return { count: events.length, full: due.length === limit };
    });

    const resolvedBefore = new Date(now.getTime() - this.config.support.autoCloseDays * 86_400_000);
    const closed = await this.db.withTransaction(async (tx) => {
      const due = await this.tickets.lockResolvedBefore(tx, resolvedBefore, limit, tenantId);
      const events: DomainEvent[] = [];
      for (const t of due) {
        const version = t.version;
        if (!t.autoClose(now)) continue;
        if (!(await this.tickets.update(tx, t, version))) continue;
        await this.tickets.insertMessages(tx, t);
        events.push(this.service.closedEvent(t, 'auto', now));
      }
      await this.outbox.append(tx, events);
      return { count: events.length, full: due.length === limit };
    });

    return { breached: breached.count, autoClosed: closed.count, more: breached.full || closed.full };
  }
}
