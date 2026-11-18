import { describe, expect, it } from 'vitest';
import {
  hasRequester,
  messageKind,
  queueQuery,
  replyStatusOptions,
  slaState,
  sortBySla,
  statusOptions,
  systemText,
  type TicketFilters,
} from './support';

const NOW = new Date('2026-10-07T12:00:00Z');
const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

describe('SLA', () => {
  it('vencido en rojo, por vencer en ámbar, en plazo en verde', () => {
    expect(slaState({ status: 'open', createdAt: at(-30), slaDueAt: at(-6) }, NOW)).toMatchObject({ tone: 'danger', overdue: true });
    expect(slaState({ status: 'open', createdAt: at(-30), slaDueAt: at(-6) }, NOW).label).toMatch(/^Vencido hace 6 h$/);
    // Queda 4 h de 24: menos del 25 %.
    expect(slaState({ status: 'in_progress', createdAt: at(-20), slaDueAt: at(4) }, NOW)).toMatchObject({ tone: 'warn', overdue: false });
    // Menos de 1 h aunque el plazo sea corto.
    expect(slaState({ status: 'open', createdAt: at(-0.1), slaDueAt: at(0.5) }, NOW).tone).toBe('warn');
    expect(slaState({ status: 'open', createdAt: at(-2), slaDueAt: at(22) }, NOW)).toMatchObject({ tone: 'ok', label: 'Vence en 22 h' });
  });

  it('esperando al cliente queda en pausa; resuelto y cerrado ya no cuentan', () => {
    expect(slaState({ status: 'pending_customer', createdAt: at(-30), slaDueAt: at(-6) }, NOW)).toMatchObject({ tone: 'neutral', overdue: true });
    expect(slaState({ status: 'resolved', createdAt: at(-30), slaDueAt: at(-6) }, NOW)).toMatchObject({ label: 'Atendido', overdue: false });
  });

  it('ordena activos primero por vencimiento', () => {
    const list = [
      { id: 'c', status: 'closed' as const, slaDueAt: at(-50), createdAt: at(-60) },
      { id: 'b', status: 'open' as const, slaDueAt: at(5), createdAt: at(-1) },
      { id: 'a', status: 'in_progress' as const, slaDueAt: at(-1), createdAt: at(-10) },
    ];
    expect(sortBySla(list).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('estados', () => {
  it('opciones según las transiciones del dominio', () => {
    expect(statusOptions('open')).toEqual(['open', 'in_progress', 'pending_customer', 'resolved']);
    expect(statusOptions('resolved')).toEqual(['resolved', 'in_progress', 'closed']);
    expect(statusOptions('closed')).toEqual(['closed']);
  });

  it('tras responder: cualquier estado de respuesta salvo con el ticket cerrado', () => {
    expect(replyStatusOptions('open')).toEqual(['pending_customer', 'in_progress', 'resolved']);
    expect(replyStatusOptions('resolved')).toEqual(['pending_customer', 'in_progress', 'resolved']);
    expect(replyStatusOptions('closed')).toEqual([]);
  });

  it('sin cliente solo se admiten notas', () => {
    expect(hasRequester({ requesterId: null, requesterContact: null })).toBe(false);
    expect(hasRequester({ requesterId: null, requesterContact: { name: 'A', email: null, phone: '099' } })).toBe(false);
    expect(hasRequester({ requesterId: null, requesterContact: { name: null, email: 'a@b.ec', phone: null } })).toBe(true);
    expect(hasRequester({ requesterId: 'u1', requesterContact: null })).toBe(true);
  });
});

describe('mensajes', () => {
  it('distingue cliente, respuesta, nota interna y sistema', () => {
    expect(messageKind({ authorType: 'customer', isInternal: false })).toBe('customer');
    expect(messageKind({ authorType: 'staff', isInternal: false })).toBe('agent');
    expect(messageKind({ authorType: 'staff', isInternal: true })).toBe('note');
    expect(messageKind({ authorType: 'system', isInternal: true })).toBe('system');
    expect(messageKind({ authorType: 'bot', isInternal: false })).toBe('system');
  });

  it('traduce los códigos de los mensajes de sistema', () => {
    expect(systemText('Estado: open → in_progress')).toBe('Estado: Abierto → En curso');
    expect(systemText('Prioridad: normal → urgent')).toBe('Prioridad: Normal → Urgente');
    expect(systemText('Categoría: other → delivery')).toBe('Categoría: Otro → Entrega');
    expect(systemText('Ticket sin asignar')).toBe('Ticket sin asignar');
  });
});

describe('filtros de la cola', () => {
  const base: TicketFilters = { status: 'active', priority: '', assigned: '', overdue: false, number: '' };

  it('activos = abiertos, en curso y esperando al cliente', () => {
    expect(queueQuery(base, 25, 0)).toMatchObject({ status: ['open', 'in_progress', 'pending_customer'], limit: 25, offset: 0 });
    expect(queueQuery({ ...base, status: '' }, 25, 0).status).toBeUndefined();
  });

  it('asignación, vencidos y número (solo dígitos)', () => {
    const q = queueQuery({ ...base, status: 'resolved', priority: 'urgent', assigned: 'none', overdue: true, number: '#123 ' }, 25, 50);
    expect(q).toMatchObject({ status: ['resolved'], priority: ['urgent'], assignedTo: 'none', overdue: true, number: '123', offset: 50 });
    expect(queueQuery(base, 25, 0).overdue).toBeUndefined();
  });
});
