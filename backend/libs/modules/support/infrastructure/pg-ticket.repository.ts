import { Injectable } from '@nestjs/common';
import { Queryable } from '../../../shared-kernel';
import { TicketFilter, TicketRepository } from '../application/ports';
import { SLA_ALERT_STATUSES } from '../domain/sla';
import { AuthorType, RequesterContact, Ticket, TicketMessage, TicketProps } from '../domain/ticket';

const COLUMNS = `t.id, t.tenant_id, t.number::text AS number, t.requester_id, t.requester_contact, t.order_id, t.shipment_id,
  t.channel, t.category, t.priority, t.status, t.subject, t.assigned_to, t.sla_due_at, t.sla_breached_at,
  t.first_response_at, t.resolved_at, t.closed_at, t.csat, t.csat_comment, t.csat_at, t.source_ref, t.version,
  t.created_at, t.updated_at`;

interface TicketRow {
  id: string;
  tenant_id: string;
  number: string;
  requester_id: string | null;
  requester_contact: RequesterContact | null;
  order_id: string | null;
  shipment_id: string | null;
  channel: TicketProps['channel'];
  category: TicketProps['category'];
  priority: TicketProps['priority'];
  status: TicketProps['status'];
  subject: string;
  assigned_to: string | null;
  sla_due_at: Date;
  sla_breached_at: Date | null;
  first_response_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  csat: number | null;
  csat_comment: string | null;
  csat_at: Date | null;
  source_ref: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  author_type: AuthorType;
  author_id: string | null;
  is_internal: boolean;
  body: string;
  attachments: string[];
  created_at: Date;
}

function toProps(r: TicketRow): TicketProps {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    number: r.number,
    requesterId: r.requester_id,
    requesterContact: r.requester_contact,
    orderId: r.order_id,
    shipmentId: r.shipment_id,
    channel: r.channel,
    category: r.category,
    priority: r.priority,
    status: r.status,
    subject: r.subject,
    assignedTo: r.assigned_to,
    slaDueAt: r.sla_due_at,
    slaBreachedAt: r.sla_breached_at,
    firstResponseAt: r.first_response_at,
    resolvedAt: r.resolved_at,
    closedAt: r.closed_at,
    csat: r.csat,
    csatComment: r.csat_comment,
    csatAt: r.csat_at,
    sourceRef: r.source_ref,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class PgTicketRepository extends TicketRepository {
  async insert(q: Queryable, ticket: Ticket): Promise<string | null> {
    const p = ticket.toJSON();
    const { rows } = await q.query<{ number: string }>(
      `INSERT INTO support.tickets
         (id, tenant_id, requester_id, requester_contact, order_id, shipment_id, channel, category, priority, status,
          subject, assigned_to, sla_due_at, source_ref, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (tenant_id, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
       RETURNING number::text AS number`,
      [
        p.id, p.tenantId, p.requesterId, p.requesterContact ? JSON.stringify(p.requesterContact) : null, p.orderId, p.shipmentId,
        p.channel, p.category, p.priority, p.status, p.subject, p.assignedTo, p.slaDueAt, p.sourceRef, p.version, p.createdAt, p.updatedAt,
      ],
    );
    return rows[0]?.number ?? null;
  }

  async findById(q: Queryable, tenantId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<Ticket | null> {
    const { rows } = await q.query<TicketRow>(
      `SELECT ${COLUMNS} FROM support.tickets t WHERE t.tenant_id = $1 AND t.id = $2 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, id],
    );
    return rows[0] ? Ticket.restore(toProps(rows[0])) : null;
  }

  async findBySourceRef(q: Queryable, tenantId: string, sourceRef: string): Promise<Ticket | null> {
    const { rows } = await q.query<TicketRow>(`SELECT ${COLUMNS} FROM support.tickets t WHERE t.tenant_id = $1 AND t.source_ref = $2`, [tenantId, sourceRef]);
    return rows[0] ? Ticket.restore(toProps(rows[0])) : null;
  }

  async update(q: Queryable, ticket: Ticket, expectedVersion: number): Promise<boolean> {
    const p = ticket.toJSON();
    const { rowCount } = await q.query(
      `UPDATE support.tickets
          SET category = $3, priority = $4, status = $5, assigned_to = $6, sla_due_at = $7, sla_breached_at = $8,
              first_response_at = $9, resolved_at = $10, closed_at = $11, csat = $12, csat_comment = $13, csat_at = $14,
              updated_at = $15, version = version + 1
        WHERE tenant_id = $1 AND id = $2 AND version = $16`,
      [
        p.tenantId, p.id, p.category, p.priority, p.status, p.assignedTo, p.slaDueAt, p.slaBreachedAt,
        p.firstResponseAt, p.resolvedAt, p.closedAt, p.csat, p.csatComment, p.csatAt, p.updatedAt, expectedVersion,
      ],
    );
    return rowCount === 1;
  }

  async insertMessages(q: Queryable, ticket: Ticket): Promise<void> {
    // Uno por uno (son 1 a 3 por operación): el id de cada mensaje queda en el orden en que ocurrió.
    for (const m of ticket.newMessages) {
      if (m.id !== null) continue;
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO support.ticket_messages (ticket_id, author_type, author_id, is_internal, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id::text AS id`,
        [ticket.id, m.authorType, m.authorId, m.isInternal, m.body, m.createdAt],
      );
      m.id = rows[0].id;
    }
  }

  async listMessages(q: Queryable, ticketId: string, opts: { includeInternal: boolean }): Promise<TicketMessage[]> {
    const { rows } = await q.query<MessageRow>(
      `SELECT id::text AS id, author_type, author_id, is_internal, body, attachments, created_at
         FROM support.ticket_messages
        WHERE ticket_id = $1 ${opts.includeInternal ? '' : 'AND NOT is_internal'}
        ORDER BY created_at, id`,
      [ticketId],
    );
    return rows.map((r) => ({
      id: r.id,
      authorType: r.author_type,
      authorId: r.author_id,
      isInternal: r.is_internal,
      body: r.body,
      attachments: r.attachments ?? [],
      createdAt: r.created_at,
    }));
  }

  async list(q: Queryable, tenantId: string, f: TicketFilter): Promise<TicketProps[]> {
    const where = ['t.tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (f.statuses?.length) where.push(`t.status = ANY($${values.push(f.statuses)}::text[])`);
    if (f.priorities?.length) where.push(`t.priority = ANY($${values.push(f.priorities)}::text[])`);
    if (f.categories?.length) where.push(`t.category = ANY($${values.push(f.categories)}::text[])`);
    if (f.assignedTo === 'none') where.push('t.assigned_to IS NULL');
    else if (f.assignedTo) where.push(`t.assigned_to = $${values.push(f.assignedTo)}`);
    if (f.requesterId) where.push(`t.requester_id = $${values.push(f.requesterId)}`);
    if (f.orderId) where.push(`t.order_id = $${values.push(f.orderId)}`);
    if (f.number) where.push(`t.number = $${values.push(f.number)}::bigint`);
    if (f.overdue) where.push(`t.status IN ('open', 'in_progress', 'pending_customer') AND t.sla_due_at <= now()`);
    const limit = values.push(f.limit);
    const offset = values.push(f.offset);
    const { rows } = await q.query<TicketRow>(
      `SELECT ${COLUMNS} FROM support.tickets t
        WHERE ${where.join(' AND ')}
        ORDER BY (t.status IN ('resolved', 'closed')), t.sla_due_at, t.created_at
        LIMIT $${limit} OFFSET $${offset}`,
      values,
    );
    return rows.map(toProps);
  }

  async lockSlaBreached(q: Queryable, now: Date, limit: number, tenantId?: string): Promise<Ticket[]> {
    const values: unknown[] = [SLA_ALERT_STATUSES, now, limit];
    const tenant = tenantId ? `AND t.tenant_id = $${values.push(tenantId)}` : '';
    const { rows } = await q.query<TicketRow>(
      `SELECT ${COLUMNS} FROM support.tickets t
        WHERE t.status = ANY($1::text[]) AND t.sla_breached_at IS NULL AND t.sla_due_at <= $2 ${tenant}
        ORDER BY t.sla_due_at
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
      values,
    );
    return rows.map((r) => Ticket.restore(toProps(r)));
  }

  async lockResolvedBefore(q: Queryable, resolvedBefore: Date, limit: number, tenantId?: string): Promise<Ticket[]> {
    const values: unknown[] = [resolvedBefore, limit];
    const tenant = tenantId ? `AND t.tenant_id = $${values.push(tenantId)}` : '';
    const { rows } = await q.query<TicketRow>(
      `SELECT ${COLUMNS} FROM support.tickets t
        WHERE t.status = 'resolved' AND t.resolved_at <= $1 ${tenant}
        ORDER BY t.resolved_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      values,
    );
    return rows.map((r) => Ticket.restore(toProps(r)));
  }
}
