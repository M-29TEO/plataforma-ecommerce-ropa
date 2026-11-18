import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database, DomainEvent, NotFoundError, OutboxWriter } from '../../../shared-kernel';
import { IamApi } from '../../iam';
import { LogisticsApi } from '../../logistics';
import { OrderDetail, OrdersApi } from '../../orders';
import { signTicketAccess, verifyTicketAccess } from '../domain/access-token';
import {
  InvalidAgentError,
  InvalidTicketInputError,
  StaleTicketVersionError,
  TicketLinkNotFoundError,
  TicketNotFoundError,
} from '../domain/errors';
import { requesterOf, ticketClosed, ticketCreated, ticketReplied } from '../domain/events';
import { SlaPolicy } from '../domain/sla';
import {
  isPublicMessage,
  NewTicket,
  ReplyStatus,
  RequesterContact,
  Ticket,
  TicketCategory,
  TicketChannel,
  TicketMessage,
  TicketPriority,
  TicketProps,
  TicketStatus,
} from '../domain/ticket';
import { TicketFilter, TicketRepository } from './ports';

/** Permiso que hace de alguien un agente (al que se le puede asignar un ticket). */
export const AGENT_PERMISSION = 'support.tickets.write';

/** Ticket completo para el backoffice: con notas internas y mensajes de sistema. */
export type StaffTicketView = TicketProps & { messages: TicketMessage[] };

/** Lo que ve el cliente: sin notas internas, sin agente ni datos de gestión del SLA. */
export interface CustomerTicketView {
  id: string;
  number: string;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  orderId: string | null;
  shipmentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
  csat: number | null;
  /** Cerrado y sin calificar: puede responder la encuesta. */
  canRate: boolean;
  messages: { id: string; author: 'customer' | 'agent'; body: string; createdAt: Date }[];
}

export interface Staff {
  tenantId: string;
  userId: string;
}

export interface CustomerTicketInput {
  tenantId: string;
  userId: string;
  orderId?: string | null;
  shipmentId?: string | null;
  category: TicketCategory;
  subject: string;
  body: string;
}

export interface GuestTicketInput {
  tenantId: string;
  orderNumber: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  shipmentId?: string | null;
  category: TicketCategory;
  subject: string;
  body: string;
}

export interface StaffTicketInput {
  requesterId?: string | null;
  requesterContact?: Partial<RequesterContact> | null;
  orderId?: string | null;
  shipmentId?: string | null;
  channel: TicketChannel;
  category: TicketCategory;
  priority?: TicketPriority;
  subject: string;
  body: string;
  assignToMe?: boolean;
}

export interface SystemTicketInput {
  tenantId: string;
  sourceRef: string;
  orderId?: string | null;
  category: TicketCategory;
  priority: TicketPriority;
  subject: string;
  body: string;
}

export interface TicketChanges {
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: TicketCategory;
  expectedVersion?: number;
}

interface MutateOptions {
  expectedVersion?: number;
  /** El ticket debe ser de este cliente (si no, 404). */
  ownerId?: string;
  now?: Date;
}

/**
 * Casos de uso del módulo Soporte (schema support). Cada operación bloquea la fila del ticket,
 * aplica la regla en el agregado, guarda con concurrencia optimista (version) y deja los eventos
 * en el outbox en la misma transacción. Los emails y alertas los envía Notificaciones al
 * consumir esos eventos. El pedido y el envío se validan por las APIs de Pedidos y Logística.
 */
@Injectable()
export class TicketService {
  constructor(
    private readonly db: Database,
    private readonly tickets: TicketRepository,
    private readonly outbox: OutboxWriter,
    private readonly orders: OrdersApi,
    private readonly logistics: LogisticsApi,
    private readonly iam: IamApi,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get policy(): SlaPolicy {
    return this.config.support.slaHours;
  }

  /** Enlace firmado al ticket (para los emails). */
  accessToken(tenantId: string, ticketId: string, now = new Date()): string {
    return signTicketAccess(this.config.support.linkSecret, tenantId, ticketId, this.config.support.linkTtlDays, now);
  }

  // ================================================================== creación

  async createForCustomer(input: CustomerTicketInput): Promise<CustomerTicketView> {
    if (input.orderId) await this.linkedOrder(input.tenantId, input.orderId, input.shipmentId, input.userId);
    else if (input.shipmentId) throw new InvalidTicketInputError('Un envío se vincula junto con su pedido');
    const ticket = await this.create({
      tenantId: input.tenantId,
      createdBy: 'customer',
      requesterId: input.userId,
      orderId: input.orderId,
      shipmentId: input.shipmentId,
      channel: 'web',
      category: input.category,
      subject: input.subject,
      body: input.body,
    });
    return this.customerView(ticket);
  }

  /**
   * Invitado: identifica su pedido con el número y el email de la compra. No recibe el enlace en
   * la respuesta: le llega por email (así se prueba que el correo es suyo).
   */
  async createForGuest(input: GuestTicketInput): Promise<{ number: string; status: TicketStatus }> {
    const order = await this.orders.findOrderByNumber(input.tenantId, input.orderNumber.trim());
    if (!order || order.customer.email.trim().toLowerCase() !== input.email.trim().toLowerCase()) {
      throw new TicketLinkNotFoundError('order', input.orderNumber);
    }
    if (input.shipmentId) await this.linkedOrder(input.tenantId, order.id, input.shipmentId);
    const ticket = await this.create({
      tenantId: input.tenantId,
      createdBy: 'customer',
      requesterId: order.userId,
      requesterContact: { name: input.name || order.customer.name, email: order.customer.email, phone: input.phone || order.customer.phone || null },
      orderId: order.id,
      shipmentId: input.shipmentId,
      channel: 'web',
      category: input.category,
      subject: input.subject,
      body: input.body,
    });
    const p = ticket.toJSON();
    return { number: p.number!, status: p.status };
  }

  /**
   * Ticket registrado por un agente (llamada, WhatsApp, email). Si viene un pedido y no se indica
   * el cliente, el cliente es el del pedido.
   */
  async createByStaff(staff: Staff, input: StaffTicketInput): Promise<StaffTicketView> {
    let requesterId = input.requesterId ?? null;
    let contact = input.requesterContact ?? null;
    if (requesterId) {
      const user = await this.iam.getContact(staff.tenantId, requesterId);
      if (!user || user.userType !== 'customer') throw new InvalidTicketInputError('El cliente indicado no existe');
    }
    if (input.orderId) {
      const order = await this.linkedOrder(staff.tenantId, input.orderId, input.shipmentId);
      if (!requesterId && !contact?.email) {
        requesterId = order.userId;
        contact = { name: order.customer.name, email: order.customer.email, phone: order.customer.phone ?? null };
      }
    }
    const ticket = await this.create(
      {
        tenantId: staff.tenantId,
        createdBy: 'staff',
        actorId: staff.userId,
        requesterId,
        requesterContact: contact,
        orderId: input.orderId,
        shipmentId: input.shipmentId,
        channel: input.channel,
        category: input.category,
        priority: input.priority,
        subject: input.subject,
        body: input.body,
      },
      input.assignToMe ? staff.userId : null,
    );
    return this.staffView(ticket);
  }

  /** Ticket interno creado por un evento (p. ej. comprobante rechazado). Idempotente por sourceRef. */
  async createFromEvent(input: SystemTicketInput): Promise<TicketProps> {
    const existing = await this.tickets.findBySourceRef(this.db, input.tenantId, input.sourceRef);
    if (existing) return existing.toJSON();
    const ticket = await this.create({ ...input, createdBy: 'system', channel: 'internal' });
    return ticket.toJSON();
  }

  private create(input: NewTicket, assignTo: string | null = null, now = new Date()): Promise<Ticket> {
    return this.db.withTransaction(async (tx) => {
      const ticket = Ticket.open(input, this.policy, now);
      if (assignTo) ticket.assign(assignTo, assignTo, now);
      const number = await this.tickets.insert(tx, ticket);
      if (number === null) {
        // Mismo source_ref (evento repetido en paralelo): el ticket ya existe.
        const existing = await this.tickets.findBySourceRef(tx, input.tenantId, input.sourceRef!);
        if (!existing) throw new TicketNotFoundError(input.sourceRef!);
        return existing;
      }
      ticket.setNumber(number);
      await this.tickets.insertMessages(tx, ticket);
      const props = ticket.toJSON();
      const token = requesterOf(props) ? this.accessToken(props.tenantId, props.id, now) : null;
      await this.outbox.append(tx, [ticketCreated(props, input.createdBy, token)]);
      return ticket;
    });
  }

  /** El pedido existe (y es del cliente, si se indica) y el envío es de ese pedido. */
  private async linkedOrder(tenantId: string, orderId: string, shipmentId?: string | null, ownerId?: string): Promise<OrderDetail> {
    let order: OrderDetail;
    try {
      order = await this.orders.getOrder(tenantId, orderId);
    } catch (error) {
      if (error instanceof NotFoundError) throw new TicketLinkNotFoundError('order', orderId);
      throw error;
    }
    if (ownerId !== undefined && order.userId !== ownerId) throw new TicketLinkNotFoundError('order', orderId);
    if (shipmentId) {
      const shipments = await this.logistics.getShipments(tenantId, orderId);
      if (!shipments.some((s) => s.id === shipmentId)) throw new TicketLinkNotFoundError('shipment', shipmentId);
    }
    return order;
  }

  // ================================================================== cliente

  async listForCustomer(tenantId: string, userId: string, page: { statuses?: TicketStatus[]; limit: number; offset: number }): Promise<Omit<CustomerTicketView, 'messages'>[]> {
    const rows = await this.tickets.list(this.db, tenantId, { requesterId: userId, statuses: page.statuses, limit: page.limit, offset: page.offset });
    return rows.map((p) => {
      const { messages: _messages, ...rest } = this.toCustomerView(p, []);
      return rest;
    });
  }

  async getForCustomer(tenantId: string, userId: string, ticketId: string): Promise<CustomerTicketView> {
    const ticket = await this.tickets.findById(this.db, tenantId, ticketId);
    if (!ticket || ticket.toJSON().requesterId !== userId) throw new TicketNotFoundError(ticketId);
    return this.customerView(ticket);
  }

  async replyAsCustomer(tenantId: string, userId: string, ticketId: string, body: string): Promise<CustomerTicketView> {
    const ticket = await this.mutate(tenantId, ticketId, (t) => void t.customerReply(body, userId), { ownerId: userId });
    return this.customerView(ticket);
  }

  async rateAsCustomer(tenantId: string, userId: string, ticketId: string, score: number, comment?: string | null): Promise<CustomerTicketView> {
    const ticket = await this.mutate(tenantId, ticketId, (t) => void t.rate(score, comment), { ownerId: userId });
    return this.customerView(ticket);
  }

  // ------------------------------------------------------------------ enlace firmado (invitado)

  async getByToken(token: string): Promise<CustomerTicketView> {
    const { tid, tk } = verifyTicketAccess(this.config.support.linkSecret, token);
    const ticket = await this.tickets.findById(this.db, tid, tk);
    if (!ticket) throw new TicketNotFoundError(tk);
    return this.customerView(ticket);
  }

  async replyByToken(token: string, body: string): Promise<CustomerTicketView> {
    const { tid, tk } = verifyTicketAccess(this.config.support.linkSecret, token);
    const ticket = await this.mutate(tid, tk, (t) => void t.customerReply(body, t.toJSON().requesterId));
    return this.customerView(ticket);
  }

  async rateByToken(token: string, score: number, comment?: string | null): Promise<CustomerTicketView> {
    const { tid, tk } = verifyTicketAccess(this.config.support.linkSecret, token);
    const ticket = await this.mutate(tid, tk, (t) => void t.rate(score, comment));
    return this.customerView(ticket);
  }

  // ================================================================== backoffice

  list(tenantId: string, filter: TicketFilter): Promise<TicketProps[]> {
    return this.tickets.list(this.db, tenantId, filter);
  }

  async get(tenantId: string, ticketId: string): Promise<StaffTicketView> {
    const ticket = await this.tickets.findById(this.db, tenantId, ticketId);
    if (!ticket) throw new TicketNotFoundError(ticketId);
    return this.staffView(ticket);
  }

  /** Asigna a otro agente (o desasigna con null). El asignado debe ser staff activo con support.tickets.write. */
  async assign(staff: Staff, ticketId: string, agentId: string | null, expectedVersion?: number): Promise<StaffTicketView> {
    if (agentId && agentId !== staff.userId && !(await this.iam.staffHasPermission(staff.tenantId, agentId, AGENT_PERMISSION))) {
      throw new InvalidAgentError(agentId);
    }
    const ticket = await this.mutate(staff.tenantId, ticketId, (t) => void t.assign(agentId, staff.userId), { expectedVersion });
    return this.staffView(ticket);
  }

  /**
   * El agente toma el ticket (support.tickets.write lo verificó el guard). Quitárselo a otro agente
   * es reasignar: exige canReassign (support.tickets.assign).
   */
  async take(staff: Staff, ticketId: string, expectedVersion?: number, canReassign = false): Promise<StaffTicketView> {
    const ticket = await this.mutate(staff.tenantId, ticketId, (t) => void t.take(staff.userId, canReassign), { expectedVersion });
    return this.staffView(ticket);
  }

  async update(staff: Staff, ticketId: string, changes: TicketChanges): Promise<StaffTicketView> {
    const ticket = await this.mutate(
      staff.tenantId,
      ticketId,
      (t, now) => {
        if (changes.category) t.changeCategory(changes.category, staff.userId, now);
        if (changes.priority) t.changePriority(changes.priority, this.policy, staff.userId, now);
        if (changes.status && t.changeStatus(changes.status, staff.userId, now) && changes.status === 'closed') {
          return [this.closedEvent(t, 'staff', now)];
        }
        return [];
      },
      { expectedVersion: changes.expectedVersion },
    );
    return this.staffView(ticket);
  }

  /** Respuesta pública: queda en el ticket y sale por email al cliente (TicketReplied). */
  async reply(staff: Staff, ticketId: string, body: string, then?: ReplyStatus, expectedVersion?: number): Promise<StaffTicketView> {
    const ticket = await this.mutate(
      staff.tenantId,
      ticketId,
      (t, now) => {
        const message = t.reply(body, staff.userId, then, now);
        return [{ deferred: message }];
      },
      { expectedVersion },
    );
    return this.staffView(ticket);
  }

  async addNote(staff: Staff, ticketId: string, body: string): Promise<StaffTicketView> {
    const ticket = await this.mutate(staff.tenantId, ticketId, (t, now) => void t.addNote(body, staff.userId, now));
    return this.staffView(ticket);
  }

  // ================================================================== internos

  closedEvent(t: Ticket, closedBy: 'staff' | 'auto', now: Date): DomainEvent {
    const p = t.toJSON();
    return ticketClosed(p, closedBy, requesterOf(p) ? this.accessToken(p.tenantId, p.id, now) : null);
  }

  /**
   * Bloquea, aplica y guarda. `fn` devuelve los eventos; un `{ deferred: mensaje }` es la respuesta
   * pública, cuyo evento necesita el id del mensaje (se arma después de insertarlo).
   */
  private mutate(
    tenantId: string,
    ticketId: string,
    fn: (t: Ticket, now: Date) => (DomainEvent | { deferred: TicketMessage })[] | void,
    opts: MutateOptions = {},
  ): Promise<Ticket> {
    const now = opts.now ?? new Date();
    return this.db.withTransaction(async (tx) => {
      const ticket = await this.tickets.findById(tx, tenantId, ticketId, { forUpdate: true });
      if (!ticket || (opts.ownerId !== undefined && ticket.toJSON().requesterId !== opts.ownerId)) throw new TicketNotFoundError(ticketId);
      if (opts.expectedVersion !== undefined && ticket.version !== opts.expectedVersion) {
        throw new StaleTicketVersionError(ticketId, opts.expectedVersion, ticket.version);
      }
      const version = ticket.version;
      const before = JSON.stringify(ticket.toJSON());
      const results = fn(ticket, now) ?? [];
      if (JSON.stringify(ticket.toJSON()) === before && ticket.newMessages.length === 0) return ticket;
      if (!(await this.tickets.update(tx, ticket, version))) throw new StaleTicketVersionError(ticketId, version);
      ticket.markSaved();
      await this.tickets.insertMessages(tx, ticket);
      const props = ticket.toJSON();
      const events = results.map((r) => {
        if (!('deferred' in r)) return r;
        const requester = requesterOf(props)!;
        return ticketReplied(props, r.deferred.id!, r.deferred.body, requester, this.accessToken(props.tenantId, props.id, now));
      });
      await this.outbox.append(tx, events);
      return ticket;
    });
  }

  private async staffView(ticket: Ticket): Promise<StaffTicketView> {
    return { ...ticket.toJSON(), messages: await this.tickets.listMessages(this.db, ticket.id, { includeInternal: true }) };
  }

  private async customerView(ticket: Ticket): Promise<CustomerTicketView> {
    const messages = await this.tickets.listMessages(this.db, ticket.id, { includeInternal: false });
    return this.toCustomerView(ticket.toJSON(), messages);
  }

  private toCustomerView(p: TicketProps, messages: TicketMessage[]): CustomerTicketView {
    return {
      id: p.id,
      number: p.number ?? '',
      subject: p.subject,
      category: p.category,
      status: p.status,
      orderId: p.orderId,
      shipmentId: p.shipmentId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      resolvedAt: p.resolvedAt,
      closedAt: p.closedAt,
      csat: p.csat,
      canRate: p.status === 'closed' && p.csat === null,
      messages: messages.filter(isPublicMessage).map((m) => ({
        id: m.id!,
        author: m.authorType === 'customer' ? 'customer' : 'agent',
        body: m.body,
        createdAt: m.createdAt,
      })),
    };
  }
}
