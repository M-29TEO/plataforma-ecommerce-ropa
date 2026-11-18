import { Injectable, OnModuleInit } from '@nestjs/common';
import { AnonymizationResult, Database, DataSubject, PersonalDataContributor, PersonalDataRegistry } from '../../../shared-kernel';

const ERASED_MESSAGE = '[Mensaje eliminado a pedido del titular (LOPDP)]';

/**
 * Tickets del titular: los suyos (requester_id) y los que abrió como invitado con su email
 * (requester_contact->>'email', sin requester_id). $1 tenant, $2 usuario, $3 email (puede ser NULL).
 */
const SUBJECT_TICKETS = `t.tenant_id = $1 AND (t.requester_id = $2
  OR (t.requester_id IS NULL AND $3::text IS NOT NULL AND lower(t.requester_contact->>'email') = lower($3)))`;

interface TicketRow {
  id: string;
  number: string;
  subject: string;
  category: string;
  status: string;
  csat: number | null;
  csat_comment: string | null;
  created_at: Date;
}

interface MessageRow {
  ticket_id: string;
  author_type: string;
  body: string;
  created_at: Date;
}

/**
 * LOPDP en Soporte (schema support). Exporta los tickets del titular (número, asunto, categoría,
 * estado, encuesta CSAT) con sus mensajes visibles para el cliente; las notas internas
 * (is_internal) nunca salen.
 *
 * Anonimiza en esos tickets: requester_contact (nombre, email, teléfono de invitado) y el
 * comentario CSAT quedan NULL; sus mensajes (author_type 'customer') se reemplazan por un aviso y
 * pierden los adjuntos. Se conservan el ticket (asunto incluido, que lo escribe el cliente y puede
 * traer datos, pero es el título del caso) y las respuestas del equipo: historial de atención.
 */
@Injectable()
export class SupportPersonalDataContributor extends PersonalDataContributor implements OnModuleInit {
  readonly section = 'soporte';

  constructor(
    private readonly registry: PersonalDataRegistry,
    private readonly db: Database,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async exportData(subject: DataSubject): Promise<unknown> {
    const params = [subject.tenantId, subject.userId, subject.email];
    const { rows: tickets } = await this.db.query<TicketRow>(
      `SELECT t.id, t.number::text AS number, t.subject, t.category, t.status, t.csat, t.csat_comment, t.created_at
         FROM support.tickets t WHERE ${SUBJECT_TICKETS} ORDER BY t.created_at`,
      params,
    );
    const { rows: messages } = await this.db.query<MessageRow>(
      `SELECT m.ticket_id, m.author_type, m.body, m.created_at
         FROM support.ticket_messages m JOIN support.tickets t ON t.id = m.ticket_id
        WHERE ${SUBJECT_TICKETS} AND NOT m.is_internal
        ORDER BY m.created_at, m.id`,
      params,
    );
    return tickets.map((t) => ({
      number: t.number,
      subject: t.subject,
      category: t.category,
      status: t.status,
      csat: t.csat,
      csatComment: t.csat_comment,
      createdAt: t.created_at.toISOString(),
      messages: messages
        .filter((m) => m.ticket_id === t.id)
        .map((m) => ({ authorType: m.author_type, body: m.body, createdAt: m.created_at.toISOString() })),
    }));
  }

  async anonymize(subject: DataSubject): Promise<AnonymizationResult> {
    const params = [subject.tenantId, subject.userId, subject.email];
    // Mensajes primero: el UPDATE de tickets borra el email con el que se ubican los de invitado.
    const messages = await this.db.query(
      `UPDATE support.ticket_messages m SET body = $4, attachments = '{}'
         FROM support.tickets t
        WHERE t.id = m.ticket_id AND ${SUBJECT_TICKETS} AND m.author_type = 'customer'`,
      [...params, ERASED_MESSAGE],
    );
    const tickets = await this.db.query(
      `UPDATE support.tickets t SET requester_contact = NULL, csat_comment = NULL, version = version + 1
        WHERE ${SUBJECT_TICKETS}`,
      params,
    );
    return {
      affected: (messages.rowCount ?? 0) + (tickets.rowCount ?? 0),
      retained: ['Tickets de soporte (número, asunto, categoría, estado y respuestas del equipo) como historial de atención, sin tus datos de contacto ni tus mensajes'],
    };
  }
}
