import { ConflictError, NotFoundError, ValidationError } from '../../../shared-kernel';

export class TicketNotFoundError extends NotFoundError {
  constructor(ticketId: string) {
    super('TICKET_NOT_FOUND', 'Ticket no encontrado', { ticketId });
  }
}

/** El pedido o el envío no existe, no es del cliente o el envío no es de ese pedido. */
export class TicketLinkNotFoundError extends NotFoundError {
  constructor(kind: 'order' | 'shipment', id: string) {
    super(kind === 'order' ? 'TICKET_ORDER_NOT_FOUND' : 'TICKET_SHIPMENT_NOT_FOUND', kind === 'order' ? 'Pedido no encontrado' : 'Envío no encontrado en ese pedido', {
      [`${kind}Id`]: id,
    });
  }
}

export class InvalidTicketTransitionError extends ConflictError {
  constructor(from: string, to: string) {
    super('INVALID_TICKET_TRANSITION', `Un ticket "${from}" no puede pasar a "${to}"`, { from, to });
  }
}

/** Un ticket cerrado ya no admite mensajes ni cambios: el cliente abre uno nuevo. */
export class TicketClosedError extends ConflictError {
  constructor(ticketId: string) {
    super('TICKET_CLOSED', 'El ticket está cerrado; abre uno nuevo si necesitas más ayuda', { ticketId });
  }
}

export class StaleTicketVersionError extends ConflictError {
  constructor(ticketId: string, expectedVersion: number, currentVersion?: number) {
    super('STALE_VERSION', 'El ticket fue modificado por otra operación; recarga y reintenta', { ticketId, expectedVersion, currentVersion });
  }
}

/** "Tomar" un ticket que ya atiende otro agente exige support.tickets.assign (es una reasignación). */
export class TicketAlreadyAssignedError extends ConflictError {
  constructor(ticketId: string, assignedTo: string) {
    super('TICKET_ALREADY_ASSIGNED', 'El ticket ya lo atiende otro agente; pide a un supervisor que lo reasigne', { ticketId, assignedTo });
  }
}

/** El asignado no es un agente: usuario staff activo con support.tickets.write. */
export class InvalidAgentError extends ValidationError {
  constructor(agentId: string) {
    super('INVALID_AGENT', 'El usuario no es un agente de soporte activo', { agentId });
  }
}

/** Respuesta pública en un ticket sin cliente (ticket interno): no hay a quién escribirle. */
export class TicketWithoutRequesterError extends ValidationError {
  constructor(ticketId: string) {
    super('TICKET_WITHOUT_REQUESTER', 'El ticket no tiene cliente: usa una nota interna', { ticketId });
  }
}

export class InvalidTicketInputError extends ValidationError {
  constructor(message: string) {
    super('INVALID_TICKET_INPUT', message);
  }
}

export class CsatNotAllowedError extends ConflictError {
  constructor(ticketId: string, reason: 'not_closed' | 'already_rated') {
    super(
      'CSAT_NOT_ALLOWED',
      reason === 'not_closed' ? 'La encuesta se responde cuando el ticket está cerrado' : 'Ya respondiste la encuesta de este ticket',
      { ticketId, reason },
    );
  }
}

export class InvalidTicketTokenError extends NotFoundError {
  constructor() {
    super('TICKET_LINK_INVALID', 'El enlace del ticket no es válido');
  }
}

export class ExpiredTicketTokenError extends ValidationError {
  constructor() {
    super('TICKET_LINK_EXPIRED', 'El enlace del ticket venció; revisa el correo más reciente de soporte');
  }
}
