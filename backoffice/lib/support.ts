import type { Tone } from '@/components/ui/Badge';
import { formatRelative } from './format';

/**
 * Soporte: tipos de /support/tickets (módulo Soporte) y helpers puros (etiquetas, transiciones,
 * estado del SLA, tipo de cada mensaje). Contrato: backend/libs/modules/support.
 */

export const TICKET_STATUSES = ['open', 'pending_customer', 'in_progress', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = ['order_status', 'delivery', 'payment', 'return', 'product', 'invoice', 'account', 'complaint', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_CHANNELS = ['web', 'whatsapp', 'email', 'phone', 'chat', 'internal'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

/** Estado en que puede quedar el ticket tras responder al cliente. */
export const REPLY_STATUSES = ['pending_customer', 'in_progress', 'resolved'] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

export const BODY_MAX = 5000;

export type AuthorType = 'customer' | 'staff' | 'system' | 'bot';

export interface TicketMessage {
  id: string | null;
  authorType: AuthorType;
  authorId: string | null;
  isInternal: boolean;
  body: string;
  attachments: string[];
  createdAt: string;
}

export interface RequesterContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** Fila de GET /support/tickets (TicketProps). */
export interface Ticket {
  id: string;
  tenantId: string;
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
  slaDueAt: string;
  slaBreachedAt: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  csat: number | null;
  csatComment: string | null;
  csatAt: string | null;
  sourceRef: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /support/tickets/:id: con notas internas y mensajes de sistema. */
export interface TicketDetail extends Ticket {
  messages: TicketMessage[];
}

export const STATUS_MAP: Record<TicketStatus, [string, Tone]> = {
  open: ['Abierto', 'accent'],
  in_progress: ['En curso', 'info'],
  pending_customer: ['Esperando al cliente', 'warn'],
  resolved: ['Resuelto', 'ok'],
  closed: ['Cerrado', 'neutral'],
};

export const PRIORITY_MAP: Record<TicketPriority, [string, Tone]> = {
  low: ['Baja', 'neutral'],
  normal: ['Normal', 'info'],
  high: ['Alta', 'warn'],
  urgent: ['Urgente', 'danger'],
};

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  order_status: 'Estado del pedido',
  delivery: 'Entrega',
  payment: 'Pago',
  return: 'Devolución',
  product: 'Producto',
  invoice: 'Factura',
  account: 'Cuenta',
  complaint: 'Reclamo',
  other: 'Otro',
};

export const CHANNEL_LABELS: Record<TicketChannel, string> = {
  web: 'Web',
  whatsapp: 'WhatsApp',
  email: 'Email',
  phone: 'Teléfono',
  chat: 'Chat',
  internal: 'Interno',
};

/** Mismas transiciones manuales que el dominio (ticket.ts). */
const TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  open: ['in_progress', 'pending_customer', 'resolved'],
  in_progress: ['pending_customer', 'resolved'],
  pending_customer: ['in_progress', 'resolved'],
  resolved: ['in_progress', 'closed'],
  closed: [],
};

/** Opciones del selector de estado: el actual más a los que puede pasar. */
export function statusOptions(current: TicketStatus): TicketStatus[] {
  return [current, ...TRANSITIONS[current]];
}

/** Estados a los que puede quedar tras responder, desde el actual (responder un resuelto lo reabre). */
export function replyStatusOptions(current: TicketStatus): ReplyStatus[] {
  if (current === 'closed') return [];
  return REPLY_STATUSES.filter((s) => {
    if (s === current) return true;
    const from = current === 'resolved' ? 'in_progress' : current;
    return from === s || TRANSITIONS[from].includes(s);
  });
}

/** Un ticket sin cliente (p. ej. el interno por una factura rechazada) solo admite notas. */
export function hasRequester(t: Pick<Ticket, 'requesterId' | 'requesterContact'>): boolean {
  return Boolean(t.requesterId || t.requesterContact?.email);
}

/** Estados con el reloj del SLA corriendo (los demás no alertan). */
const SLA_RUNNING: readonly TicketStatus[] = ['open', 'in_progress'];

export interface SlaState {
  label: string;
  tone: Tone;
  overdue: boolean;
}

/**
 * Indicador del SLA: vencido (rojo), por vencer (ámbar: queda menos del 25 % del plazo o menos de
 * 1 h), en plazo (verde). Resuelto/cerrado ya no cuenta; esperando al cliente queda en pausa.
 */
export function slaState(t: Pick<Ticket, 'status' | 'slaDueAt' | 'createdAt'>, now = new Date()): SlaState {
  if (t.status === 'resolved' || t.status === 'closed') return { label: 'Atendido', tone: 'neutral', overdue: false };
  const due = new Date(t.slaDueAt).getTime();
  const left = due - now.getTime();
  const overdue = left <= 0;
  if (!SLA_RUNNING.includes(t.status)) {
    return { label: overdue ? `Venció ${formatRelative(t.slaDueAt, now)} (en pausa)` : `En pausa · vence ${formatRelative(t.slaDueAt, now)}`, tone: 'neutral', overdue };
  }
  if (overdue) return { label: `Vencido ${formatRelative(t.slaDueAt, now)}`, tone: 'danger', overdue: true };
  const span = due - new Date(t.createdAt).getTime();
  const soon = left < 3_600_000 || (span > 0 && left / span < 0.25);
  return { label: `Vence ${formatRelative(t.slaDueAt, now)}`, tone: soon ? 'warn' : 'ok', overdue: false };
}

/** Orden de la cola: activos primero, por vencimiento del SLA y luego por antigüedad (como el API). */
export function sortBySla<T extends Pick<Ticket, 'status' | 'slaDueAt' | 'createdAt'>>(tickets: readonly T[]): T[] {
  const done = (s: TicketStatus) => (s === 'resolved' || s === 'closed' ? 1 : 0);
  return [...tickets].sort(
    (a, b) =>
      done(a.status) - done(b.status) ||
      new Date(a.slaDueAt).getTime() - new Date(b.slaDueAt).getTime() ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

export type MessageKind = 'customer' | 'agent' | 'note' | 'system';

/**
 * Cómo se muestra un mensaje: del cliente, respuesta del agente (pública, salió por email), nota
 * interna (staff + interno) o evento del sistema (asignación, cambio de estado…).
 */
export function messageKind(m: Pick<TicketMessage, 'authorType' | 'isInternal'>): MessageKind {
  if (m.authorType === 'customer') return 'customer';
  if (m.authorType === 'staff') return m.isInternal ? 'note' : 'agent';
  // Un mensaje de sistema público (el primero de un ticket automático) también es del sistema.
  return 'system';
}

/** Mensajes del sistema con los códigos del dominio traducidos ("Estado: open → in_progress"). */
export function systemText(body: string): string {
  const labels: Record<string, string> = {
    ...Object.fromEntries(Object.entries(STATUS_MAP).map(([k, [v]]) => [k, v])),
    ...Object.fromEntries(Object.entries(PRIORITY_MAP).map(([k, [v]]) => [k, v])),
    ...CATEGORY_LABELS,
  };
  return body.replace(/^(Estado|Prioridad|Categoría): (\w+) → (\w+)$/, (_m, field: string, a: string, b: string) => `${field}: ${labels[a] ?? a} → ${labels[b] ?? b}`);
}

export interface TicketFilters {
  /** 'active' = abiertos, en curso y esperando al cliente; '' = todos. */
  status: TicketStatus | 'active' | '';
  priority: TicketPriority | '';
  assigned: 'me' | 'none' | '';
  overdue: boolean;
  /** Número de ticket (solo dígitos). */
  number: string;
}

export const ACTIVE_STATUSES: readonly TicketStatus[] = ['open', 'in_progress', 'pending_customer'];

/** Filtros de la pantalla → query de GET /support/tickets. */
export function queueQuery(f: TicketFilters, limit: number, offset: number): Record<string, string | number | boolean | readonly string[] | undefined> {
  const number = f.number.replace(/\D/g, '').slice(0, 18);
  return {
    status: f.status === 'active' ? ACTIVE_STATUSES : f.status ? [f.status] : undefined,
    priority: f.priority ? [f.priority] : undefined,
    assignedTo: f.assigned || undefined,
    overdue: f.overdue || undefined,
    number: number || undefined,
    limit,
    offset,
  };
}

export const CSAT_LABELS: Record<number, string> = {
  1: 'Muy insatisfecho',
  2: 'Insatisfecho',
  3: 'Neutral',
  4: 'Satisfecho',
  5: 'Muy satisfecho',
};

/** Etiquetas de estados de pedido (ficha del pedido vinculado). */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  created: 'Creado',
  paid: 'Pagado',
  preparing: 'En preparación',
  shipped: 'Despachado',
  in_transit: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
  partially_returned: 'Devuelto parcial',
  returned: 'Devuelto',
};

/** Lo que se usa del pedido vinculado (GET /orders/:id). */
export interface LinkedOrder {
  id: string;
  orderNumber: string | null;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  fulfillmentType: string;
  total: string;
  customer: { name: string; email: string; phone?: string };
  placedAt: string;
  deliveredAt: string | null;
}

/** Agente de soporte (GET /iam/users?type=staff&role=support). */
export interface Agent {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
}
