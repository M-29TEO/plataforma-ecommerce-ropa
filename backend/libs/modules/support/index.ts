/**
 * API PÚBLICA del módulo Soporte. Otros módulos solo pueden importar desde aquí.
 */
export { SupportConsumersModule, SupportModule, SupportWorkerModule } from './support.module';
export type { SweepRun } from './application/sla-monitor.service';
export { TICKET_CATEGORIES, TICKET_CHANNELS, TICKET_PRIORITIES, TICKET_STATUSES } from './domain/ticket';
export type { TicketCategory, TicketChannel, TicketPriority, TicketStatus } from './domain/ticket';
export { TICKET_CLOSED, TICKET_CREATED, TICKET_REPLIED, TICKET_SLA_BREACHED } from './domain/events';
export type {
  TicketClosedPayload,
  TicketCreatedPayload,
  TicketRepliedPayload,
  TicketRequester,
  TicketSlaBreachedPayload,
} from './domain/events';
