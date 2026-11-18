/** Puertos de persistencia del módulo Soporte (schema support). */
import { Queryable } from '../../../shared-kernel';
import { Ticket, TicketCategory, TicketMessage, TicketPriority, TicketProps, TicketStatus } from '../domain/ticket';

export interface TicketFilter {
  statuses?: TicketStatus[];
  priorities?: TicketPriority[];
  categories?: TicketCategory[];
  /** uuid del agente, o 'none' para los que no tienen agente. */
  assignedTo?: string;
  requesterId?: string;
  orderId?: string;
  /** true: SLA vencido (alertado o no) y todavía sin resolver. */
  overdue?: boolean;
  /** Número de ticket exacto. */
  number?: string;
  limit: number;
  offset: number;
}

export abstract class TicketRepository {
  /** Devuelve el número asignado, o null si ya existía un ticket con el mismo source_ref. */
  abstract insert(q: Queryable, ticket: Ticket): Promise<string | null>;
  abstract findById(q: Queryable, tenantId: string, id: string, opts?: { forUpdate?: boolean }): Promise<Ticket | null>;
  abstract findBySourceRef(q: Queryable, tenantId: string, sourceRef: string): Promise<Ticket | null>;
  /** Concurrencia optimista: false si la versión ya no es expectedVersion. Incrementa version. */
  abstract update(q: Queryable, ticket: Ticket, expectedVersion: number): Promise<boolean>;
  /** Inserta los mensajes nuevos del agregado y les asigna su id. */
  abstract insertMessages(q: Queryable, ticket: Ticket): Promise<void>;
  abstract listMessages(q: Queryable, ticketId: string, opts: { includeInternal: boolean }): Promise<TicketMessage[]>;
  /** Cola ordenada por vencimiento del SLA (los más urgentes primero). */
  abstract list(q: Queryable, tenantId: string, filter: TicketFilter): Promise<TicketProps[]>;
  /** Tickets con el SLA vencido y sin alertar, bloqueados (SKIP LOCKED) para la transacción en curso. */
  abstract lockSlaBreached(q: Queryable, now: Date, limit: number, tenantId?: string): Promise<Ticket[]>;
  /** Tickets resueltos antes de `resolvedBefore`, bloqueados (SKIP LOCKED). */
  abstract lockResolvedBefore(q: Queryable, resolvedBefore: Date, limit: number, tenantId?: string): Promise<Ticket[]>;
}
