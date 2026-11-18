import { randomUUID } from 'node:crypto';
import {
  CsatNotAllowedError,
  InvalidTicketInputError,
  InvalidTicketTransitionError,
  TicketAlreadyAssignedError,
  TicketClosedError,
  TicketWithoutRequesterError,
} from './errors';
import { SLA_ALERT_STATUSES, SlaPolicy, slaDueAt } from './sla';

/**
 * Ticket de soporte: support.tickets + support.ticket_messages.
 *
 *   open ──▶ in_progress ◀──▶ pending_customer
 *     │          │                  │
 *     └──────────┴──▶ resolved ◀────┘
 *                        │  └──▶ in_progress (el cliente responde o el agente reabre)
 *                        └──▶ closed (agente o cierre automático) ──▶ encuesta CSAT
 *
 * Mensajes: los del cliente y las respuestas del agente son públicos (la respuesta sale por email);
 * las notas internas y los mensajes de sistema (asignación, cambios de estado) nunca se muestran
 * al cliente.
 */

/** Mismos valores que los CHECK de support.tickets. */
export const TICKET_CHANNELS = ['web', 'whatsapp', 'email', 'phone', 'chat', 'internal'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

export const TICKET_CATEGORIES = ['order_status', 'delivery', 'payment', 'return', 'product', 'invoice', 'account', 'complaint', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ['open', 'pending_customer', 'in_progress', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export type AuthorType = 'customer' | 'staff' | 'system' | 'bot';

/** Estados a los que el agente puede mover el ticket a mano (desde cada estado). */
const TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  open: ['in_progress', 'pending_customer', 'resolved'],
  in_progress: ['pending_customer', 'resolved'],
  pending_customer: ['in_progress', 'resolved'],
  resolved: ['in_progress', 'closed'],
  closed: [],
};

/** Estado en el que puede quedar el ticket tras una respuesta pública del agente. */
export const REPLY_STATUSES = ['pending_customer', 'in_progress', 'resolved'] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

export const SUBJECT_MAX = 200;
export const BODY_MAX = 5000;
export const CSAT_COMMENT_MAX = 1000;

/** Contacto de un invitado (o de quien llamó por teléfono): requester_contact. */
export interface RequesterContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface TicketMessage {
  /** bigint identity: llega como texto desde PostgreSQL. null hasta que se inserta. */
  id: string | null;
  authorType: AuthorType;
  authorId: string | null;
  isInternal: boolean;
  body: string;
  attachments: string[];
  createdAt: Date;
}

export interface TicketProps {
  id: string;
  tenantId: string;
  /** Número visible (identity). null hasta que se inserta. */
  number: string | null;
  requesterId: string | null;
  requesterContact: RequesterContact | null;
  orderId: string | null;
  shipmentId: string | null;
  channel: TicketChannel;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  subject: string;
  assignedTo: string | null;
  slaDueAt: Date;
  slaBreachedAt: Date | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  csat: number | null;
  csatComment: string | null;
  csatAt: Date | null;
  sourceRef: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type TicketCreator = 'customer' | 'staff' | 'system';

export interface NewTicket {
  tenantId: string;
  createdBy: TicketCreator;
  /** Agente que lo registra (createdBy 'staff'). */
  actorId?: string | null;
  requesterId?: string | null;
  requesterContact?: Partial<RequesterContact> | null;
  orderId?: string | null;
  shipmentId?: string | null;
  channel: TicketChannel;
  category: TicketCategory;
  priority?: TicketPriority;
  subject: string;
  /** Descripción del problema: primer mensaje. */
  body: string;
  sourceRef?: string | null;
}

function clean(text: string, max: number, field: string): string {
  const value = text.trim();
  if (value.length === 0) throw new InvalidTicketInputError(`${field} no puede estar vacío`);
  if (value.length > max) throw new InvalidTicketInputError(`${field} admite hasta ${max} caracteres`);
  return value;
}

function cleanContact(c: Partial<RequesterContact> | null | undefined): RequesterContact | null {
  if (!c) return null;
  const email = c.email?.trim().toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InvalidTicketInputError('Email de contacto inválido');
  const contact = { name: c.name?.trim() || null, email, phone: c.phone?.trim() || null };
  return contact.name || contact.email || contact.phone ? contact : null;
}

export class Ticket {
  /** Mensajes agregados en esta operación (el repositorio los inserta). */
  private readonly added: TicketMessage[] = [];

  private constructor(private props: TicketProps) {}

  static restore(props: TicketProps): Ticket {
    return new Ticket({ ...props });
  }

  static open(input: NewTicket, policy: SlaPolicy, now = new Date()): Ticket {
    const contact = cleanContact(input.requesterContact);
    if (input.createdBy !== 'system' && !input.requesterId && !contact?.email) {
      throw new InvalidTicketInputError('Indica el cliente o un email de contacto');
    }
    if (input.shipmentId && !input.orderId) throw new InvalidTicketInputError('Un envío se vincula junto con su pedido');
    const priority = input.priority ?? 'normal';
    const ticket = new Ticket({
      id: randomUUID(),
      tenantId: input.tenantId,
      number: null,
      requesterId: input.requesterId ?? null,
      requesterContact: contact,
      orderId: input.orderId ?? null,
      shipmentId: input.shipmentId ?? null,
      channel: input.channel,
      category: input.category,
      priority,
      status: 'open',
      subject: clean(input.subject, SUBJECT_MAX, 'El asunto'),
      assignedTo: null,
      slaDueAt: slaDueAt(now, priority, policy),
      slaBreachedAt: null,
      firstResponseAt: null,
      resolvedAt: null,
      closedAt: null,
      csat: null,
      csatComment: null,
      csatAt: null,
      sourceRef: input.sourceRef ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const authorType: AuthorType = input.createdBy;
    const authorId = input.createdBy === 'customer' ? (input.requesterId ?? null) : (input.actorId ?? null);
    ticket.push(authorType, authorId, input.createdBy === 'system', clean(input.body, BODY_MAX, 'El mensaje'), now);
    return ticket;
  }

  get id(): string {
    return this.props.id;
  }
  get tenantId(): string {
    return this.props.tenantId;
  }
  get status(): TicketStatus {
    return this.props.status;
  }
  get version(): number {
    return this.props.version;
  }
  get hasRequester(): boolean {
    return Boolean(this.props.requesterId || this.props.requesterContact?.email);
  }

  /** Mensajes nuevos de esta operación, en orden. */
  get newMessages(): readonly TicketMessage[] {
    return this.added;
  }

  setNumber(number: string): void {
    this.props.number = number;
  }

  /** El repositorio guardó el cambio (version = version + 1). */
  markSaved(): void {
    this.props.version += 1;
  }

  toJSON(): TicketProps {
    return { ...this.props, requesterContact: this.props.requesterContact ? { ...this.props.requesterContact } : null };
  }

  // ------------------------------------------------------------------ agente

  /**
   * Asigna (o desasigna con null). Un ticket 'open' asignado pasa a 'in_progress'. Devuelve false
   * si ya estaba asignado a ese agente.
   */
  assign(agentId: string | null, actorId: string, now = new Date()): boolean {
    this.assertNotClosed();
    if (this.props.assignedTo === agentId) return false;
    this.props.assignedTo = agentId;
    this.push('system', actorId, true, agentId ? `Asignado al agente ${agentId}` : 'Ticket sin asignar', now);
    if (agentId && this.props.status === 'open') this.moveTo('in_progress', actorId, now);
    this.touch(now);
    return true;
  }

  /**
   * El agente se lo asigna a sí mismo. Si ya lo atiende otro agente, solo quien puede reasignar
   * (support.tickets.assign) puede quitárselo; si no, 409 TICKET_ALREADY_ASSIGNED.
   */
  take(agentId: string, canReassign: boolean, now = new Date()): boolean {
    const current = this.props.assignedTo;
    if (current && current !== agentId && !canReassign) throw new TicketAlreadyAssignedError(this.props.id, current);
    return this.assign(agentId, agentId, now);
  }

  /** Cambio de estado manual del agente. Devuelve false si ya estaba en ese estado. */
  changeStatus(to: TicketStatus, actorId: string | null, now = new Date()): boolean {
    if (this.props.status === to) return false;
    this.assertNotClosed();
    if (!TRANSITIONS[this.props.status].includes(to)) throw new InvalidTicketTransitionError(this.props.status, to);
    this.moveTo(to, actorId, now);
    this.touch(now);
    return true;
  }

  /** Recalcula el SLA desde la creación. Si el nuevo vencimiento es futuro, se podrá volver a alertar. */
  changePriority(priority: TicketPriority, policy: SlaPolicy, actorId: string, now = new Date()): boolean {
    this.assertNotClosed();
    if (this.props.priority === priority) return false;
    const from = this.props.priority;
    this.props.priority = priority;
    this.props.slaDueAt = slaDueAt(this.props.createdAt, priority, policy);
    if (this.props.slaDueAt > now) this.props.slaBreachedAt = null;
    this.push('system', actorId, true, `Prioridad: ${from} → ${priority}`, now);
    this.touch(now);
    return true;
  }

  changeCategory(category: TicketCategory, actorId: string, now = new Date()): boolean {
    this.assertNotClosed();
    if (this.props.category === category) return false;
    const from = this.props.category;
    this.props.category = category;
    this.push('system', actorId, true, `Categoría: ${from} → ${category}`, now);
    this.touch(now);
    return true;
  }

  /**
   * Respuesta pública del agente (sale por email al cliente). Marca la primera respuesta, asigna el
   * ticket a quien responde si no tenía agente y lo deja en `then` (por defecto, esperando al cliente).
   */
  reply(body: string, agentId: string, then: ReplyStatus = 'pending_customer', now = new Date()): TicketMessage {
    this.assertNotClosed();
    if (!this.hasRequester) throw new TicketWithoutRequesterError(this.props.id);
    const message = this.push('staff', agentId, false, clean(body, BODY_MAX, 'El mensaje'), now);
    this.props.firstResponseAt ??= now;
    if (!this.props.assignedTo) this.props.assignedTo = agentId;
    if (this.props.status !== then) {
      // Responder un ticket resuelto lo reabre; desde ahí se puede volver a esperar al cliente.
      if (this.props.status === 'resolved' && then !== 'resolved') this.moveTo('in_progress', agentId, now);
      if (this.props.status !== then) {
        if (!TRANSITIONS[this.props.status].includes(then)) throw new InvalidTicketTransitionError(this.props.status, then);
        this.moveTo(then, agentId, now);
      }
    }
    this.touch(now);
    return message;
  }

  /** Nota interna: solo la ve el backoffice; no cambia el estado ni cuenta como respuesta. */
  addNote(body: string, agentId: string, now = new Date()): TicketMessage {
    this.assertNotClosed();
    const message = this.push('staff', agentId, true, clean(body, BODY_MAX, 'La nota'), now);
    this.touch(now);
    return message;
  }

  // ------------------------------------------------------------------ cliente

  /**
   * Mensaje del cliente. Si se esperaba su respuesta, o el ticket estaba resuelto (lo reabre),
   * vuelve a la cola: 'in_progress' si tiene agente, 'open' si no.
   */
  customerReply(body: string, userId: string | null, now = new Date()): TicketMessage {
    this.assertNotClosed();
    const message = this.push('customer', userId, false, clean(body, BODY_MAX, 'El mensaje'), now);
    if (this.props.status === 'pending_customer' || this.props.status === 'resolved') {
      this.moveTo(this.props.assignedTo ? 'in_progress' : 'open', null, now);
    }
    this.touch(now);
    return message;
  }

  /** Encuesta CSAT: solo con el ticket cerrado y una sola vez. */
  rate(score: number, comment: string | null | undefined, now = new Date()): void {
    if (this.props.status !== 'closed') throw new CsatNotAllowedError(this.props.id, 'not_closed');
    if (this.props.csat !== null) throw new CsatNotAllowedError(this.props.id, 'already_rated');
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new InvalidTicketInputError('La calificación va de 1 a 5');
    const text = comment?.trim() || null;
    if (text && text.length > CSAT_COMMENT_MAX) throw new InvalidTicketInputError(`El comentario admite hasta ${CSAT_COMMENT_MAX} caracteres`);
    this.props.csat = score;
    this.props.csatComment = text;
    this.props.csatAt = now;
    this.touch(now);
  }

  // ------------------------------------------------------------------ SLA (job)

  /** true si el SLA venció y todavía no se alertó (y el reloj corre en el estado actual). */
  isSlaBreached(now: Date): boolean {
    return (
      this.props.slaBreachedAt === null &&
      (SLA_ALERT_STATUSES as readonly string[]).includes(this.props.status) &&
      this.props.slaDueAt.getTime() <= now.getTime()
    );
  }

  /** Marca la alerta (una sola vez). Devuelve false si no correspondía. */
  markSlaBreached(now = new Date()): boolean {
    if (!this.isSlaBreached(now)) return false;
    this.props.slaBreachedAt = now;
    this.push('system', null, true, 'SLA vencido: se alertó al equipo de soporte', now);
    this.touch(now);
    return true;
  }

  /** Cierre automático de un ticket resuelto sin actividad del cliente. */
  autoClose(now = new Date()): boolean {
    if (this.props.status !== 'resolved') return false;
    this.moveTo('closed', null, now, 'Cerrado automáticamente: resuelto sin respuesta del cliente');
    this.touch(now);
    return true;
  }

  // ------------------------------------------------------------------ internos

  private moveTo(to: TicketStatus, actorId: string | null, now: Date, note?: string): void {
    const from = this.props.status;
    this.props.status = to;
    if (to === 'resolved') this.props.resolvedAt = now;
    else if (to === 'closed') this.props.closedAt = now;
    else this.props.resolvedAt = null;
    this.push('system', actorId, true, note ?? `Estado: ${from} → ${to}`, now);
  }

  private assertNotClosed(): void {
    if (this.props.status === 'closed') throw new TicketClosedError(this.props.id);
  }

  private touch(now: Date): void {
    this.props.updatedAt = now;
  }

  private push(authorType: AuthorType, authorId: string | null, isInternal: boolean, body: string, now: Date): TicketMessage {
    const message: TicketMessage = { id: null, authorType, authorId, isInternal, body, attachments: [], createdAt: now };
    this.added.push(message);
    return message;
  }
}

/** Lo que ve el cliente: sin notas internas ni datos de gestión. */
export function isPublicMessage(m: Pick<TicketMessage, 'isInternal'>): boolean {
  return !m.isInternal;
}
