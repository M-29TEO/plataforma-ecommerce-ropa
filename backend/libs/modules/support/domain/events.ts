import { DomainEvent } from '../../../shared-kernel';
import type { TicketCreator, TicketProps } from './ticket';

export const TICKET_CREATED = 'TicketCreated';
export const TICKET_REPLIED = 'TicketReplied';
export const TICKET_SLA_BREACHED = 'TicketSlaBreached';
export const TICKET_CLOSED = 'TicketClosed';

const AGGREGATE_TYPE = 'support.ticket';

/** Destinatario de los emails: cliente registrado (IAM completa el contacto) o el contacto del invitado. */
export interface TicketRequester {
  userId: string | null;
  email: string | null;
  phone: string | null;
  name: string | null;
}

interface TicketRef {
  ticketId: string;
  number: string;
  subject: string;
}

/**
 * Los payloads que van al cliente llevan accessToken: el enlace firmado al ticket (ver, responder
 * y la encuesta). Notificaciones no conoce el secreto ni lee support.*: arma la URL con el token.
 */

/** Consumidores: Notificaciones (acuse de recibo con el enlace, si hay cliente). */
export interface TicketCreatedPayload extends TicketRef {
  category: string;
  priority: string;
  channel: string;
  orderId: string | null;
  shipmentId: string | null;
  createdBy: TicketCreator;
  slaDueAt: string;
  requester: TicketRequester | null;
  accessToken: string | null;
}

/** Respuesta pública del agente. Consumidores: Notificaciones (email al cliente). */
export interface TicketRepliedPayload extends TicketRef {
  messageId: string;
  body: string;
  status: string;
  requester: TicketRequester;
  accessToken: string;
}

/** Consumidores: Notificaciones (alerta ntfy al backoffice). */
export interface TicketSlaBreachedPayload extends TicketRef {
  priority: string;
  category: string;
  status: string;
  assignedTo: string | null;
  orderId: string | null;
  slaDueAt: string;
  breachedAt: string;
}

/** Consumidores: Notificaciones (encuesta CSAT por email, si hay cliente). */
export interface TicketClosedPayload extends TicketRef {
  closedBy: 'staff' | 'auto';
  closedAt: string;
  requester: TicketRequester | null;
  accessToken: string | null;
}

export function requesterOf(p: TicketProps): TicketRequester | null {
  if (!p.requesterId && !p.requesterContact?.email) return null;
  return {
    userId: p.requesterId,
    email: p.requesterContact?.email ?? null,
    phone: p.requesterContact?.phone ?? null,
    name: p.requesterContact?.name ?? null,
  };
}

function ref(p: TicketProps): TicketRef {
  return { ticketId: p.id, number: p.number ?? '', subject: p.subject };
}

function event(p: TicketProps, eventType: string, payload: object): DomainEvent {
  return { tenantId: p.tenantId, aggregateType: AGGREGATE_TYPE, aggregateId: p.id, eventType, payload: { ...payload } };
}

export function ticketCreated(p: TicketProps, createdBy: TicketCreator, accessToken: string | null): DomainEvent {
  const payload: TicketCreatedPayload = {
    ...ref(p),
    category: p.category,
    priority: p.priority,
    channel: p.channel,
    orderId: p.orderId,
    shipmentId: p.shipmentId,
    createdBy,
    slaDueAt: p.slaDueAt.toISOString(),
    requester: requesterOf(p),
    accessToken,
  };
  return event(p, TICKET_CREATED, payload);
}

export function ticketReplied(p: TicketProps, messageId: string, body: string, requester: TicketRequester, accessToken: string): DomainEvent {
  const payload: TicketRepliedPayload = { ...ref(p), messageId, body, status: p.status, requester, accessToken };
  return event(p, TICKET_REPLIED, payload);
}

export function ticketSlaBreached(p: TicketProps): DomainEvent {
  const payload: TicketSlaBreachedPayload = {
    ...ref(p),
    priority: p.priority,
    category: p.category,
    status: p.status,
    assignedTo: p.assignedTo,
    orderId: p.orderId,
    slaDueAt: p.slaDueAt.toISOString(),
    breachedAt: (p.slaBreachedAt ?? new Date()).toISOString(),
  };
  return event(p, TICKET_SLA_BREACHED, payload);
}

export function ticketClosed(p: TicketProps, closedBy: 'staff' | 'auto', accessToken: string | null): DomainEvent {
  const payload: TicketClosedPayload = {
    ...ref(p),
    closedBy,
    closedAt: (p.closedAt ?? new Date()).toISOString(),
    requester: requesterOf(p),
    accessToken,
  };
  return event(p, TICKET_CLOSED, payload);
}
