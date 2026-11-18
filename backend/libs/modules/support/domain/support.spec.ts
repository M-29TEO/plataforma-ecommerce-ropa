import { signTicketAccess, verifyTicketAccess } from './access-token';
import { requesterOf, ticketClosed, ticketCreated } from './events';
import { DEFAULT_SLA_HOURS, slaDueAt } from './sla';
import { NewTicket, Ticket } from './ticket';

const T0 = new Date('2026-10-01T15:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);
const AGENT = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';

function newTicket(overrides: Partial<NewTicket> = {}): Ticket {
  const t = Ticket.open(
    {
      tenantId: 't1',
      createdBy: 'customer',
      requesterId: CUSTOMER,
      channel: 'web',
      category: 'delivery',
      subject: '  Mi pedido no llega  ',
      body: 'Han pasado 3 días',
      ...overrides,
    },
    DEFAULT_SLA_HOURS,
    T0,
  );
  t.setNumber('7');
  return t;
}

describe('Ticket: creación', () => {
  it('abre en "open" con el SLA de la prioridad y el primer mensaje del cliente', () => {
    const t = newTicket({ priority: 'high' });
    const p = t.toJSON();
    expect(p).toMatchObject({ status: 'open', priority: 'high', subject: 'Mi pedido no llega', version: 1 });
    expect(p.slaDueAt).toEqual(at(8));
    expect(t.newMessages).toEqual([expect.objectContaining({ authorType: 'customer', authorId: CUSTOMER, isInternal: false, body: 'Han pasado 3 días' })]);
  });

  it('prioridad normal por defecto (24 h)', () => {
    expect(newTicket().toJSON().slaDueAt).toEqual(at(24));
    expect(slaDueAt(T0, 'urgent', DEFAULT_SLA_HOURS)).toEqual(at(4));
    expect(slaDueAt(T0, 'low', DEFAULT_SLA_HOURS)).toEqual(at(72));
  });

  it('exige cliente o email de contacto (salvo los de sistema)', () => {
    expect(() => newTicket({ requesterId: null })).toThrow('Indica el cliente o un email de contacto');
    expect(() => newTicket({ requesterId: null, requesterContact: { email: 'no-es-email' } })).toThrow('Email de contacto inválido');
    const guest = newTicket({ requesterId: null, requesterContact: { email: ' Ana@Example.TEST ', name: 'Ana' } });
    expect(guest.toJSON().requesterContact).toEqual({ name: 'Ana', email: 'ana@example.test', phone: null });
    const system = newTicket({ createdBy: 'system', requesterId: null, channel: 'internal' });
    expect(system.hasRequester).toBe(false);
    expect(system.newMessages[0]).toMatchObject({ authorType: 'system', isInternal: true });
  });

  it('un envío se vincula junto con su pedido', () => {
    expect(() => newTicket({ shipmentId: 'ship-1' })).toThrow('Un envío se vincula junto con su pedido');
  });

  it('asunto y mensaje no vacíos ni demasiado largos', () => {
    expect(() => newTicket({ subject: '   ' })).toThrow('El asunto no puede estar vacío');
    expect(() => newTicket({ body: 'x'.repeat(5001) })).toThrow('admite hasta 5000');
  });
});

describe('Ticket: flujo del agente', () => {
  it('asignar un ticket abierto lo pasa a in_progress y deja traza interna', () => {
    const t = newTicket();
    expect(t.assign(AGENT, AGENT, at(1))).toBe(true);
    expect(t.toJSON()).toMatchObject({ assignedTo: AGENT, status: 'in_progress' });
    expect(t.newMessages.slice(1).every((m) => m.authorType === 'system' && m.isInternal)).toBe(true);
    expect(t.assign(AGENT, AGENT)).toBe(false);
  });

  it('tomar un ticket de otro agente exige poder reasignar (TICKET_ALREADY_ASSIGNED)', () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const t = newTicket();
    expect(t.take(AGENT, false, at(1))).toBe(true);
    expect(t.take(AGENT, false)).toBe(false);
    expect(() => t.take(OTHER, false)).toThrow(expect.objectContaining({ code: 'TICKET_ALREADY_ASSIGNED' }));
    expect(t.take(OTHER, true)).toBe(true);
    expect(t.toJSON().assignedTo).toBe(OTHER);
  });

  it('la respuesta pública marca la primera respuesta, autoasigna y espera al cliente', () => {
    const t = newTicket();
    const m = t.reply('Ya lo revisamos', AGENT, undefined, at(2));
    expect(m).toMatchObject({ authorType: 'staff', isInternal: false });
    expect(t.toJSON()).toMatchObject({ status: 'pending_customer', assignedTo: AGENT, firstResponseAt: at(2) });
    t.reply('Otra respuesta', AGENT, 'in_progress', at(3));
    expect(t.toJSON().firstResponseAt).toEqual(at(2));
  });

  it('responder un ticket resuelto lo reabre; responder y resolver de una vez', () => {
    const t = newTicket();
    t.reply('Listo, ya salió', AGENT, 'resolved', at(1));
    expect(t.toJSON()).toMatchObject({ status: 'resolved', resolvedAt: at(1) });
    t.reply('Una cosa más', AGENT, 'pending_customer', at(2));
    expect(t.toJSON()).toMatchObject({ status: 'pending_customer', resolvedAt: null });
  });

  it('nota interna: no cambia el estado ni cuenta como primera respuesta', () => {
    const t = newTicket();
    const n = t.addNote('Llamar al courier', AGENT, at(1));
    expect(n).toMatchObject({ isInternal: true, authorType: 'staff' });
    expect(t.toJSON()).toMatchObject({ status: 'open', firstResponseAt: null });
  });

  it('un ticket interno (sin cliente) no admite respuesta pública', () => {
    const t = newTicket({ createdBy: 'system', requesterId: null, channel: 'internal' });
    expect(() => t.reply('Hola', AGENT)).toThrow('usa una nota interna');
  });

  it('máquina de estados: solo se cierra un ticket resuelto; cerrado es final', () => {
    const t = newTicket();
    expect(() => t.changeStatus('closed', AGENT)).toThrow('no puede pasar a "closed"');
    t.changeStatus('resolved', AGENT, at(1));
    t.changeStatus('closed', AGENT, at(2));
    expect(t.toJSON()).toMatchObject({ status: 'closed', closedAt: at(2), resolvedAt: at(1) });
    expect(() => t.changeStatus('in_progress', AGENT)).toThrow('está cerrado');
    expect(() => t.addNote('x', AGENT)).toThrow('está cerrado');
    expect(t.changeStatus('closed', AGENT)).toBe(false);
  });

  it('cambiar la prioridad recalcula el SLA desde la creación y rearma la alerta si queda en el futuro', () => {
    const t = newTicket();
    t.markSlaBreached(at(25));
    expect(t.toJSON().slaBreachedAt).toEqual(at(25));
    t.changePriority('low', DEFAULT_SLA_HOURS, AGENT, at(26));
    expect(t.toJSON()).toMatchObject({ slaDueAt: at(72), slaBreachedAt: null });
    t.changePriority('urgent', DEFAULT_SLA_HOURS, AGENT, at(27));
    expect(t.toJSON().slaDueAt).toEqual(at(4));
    expect(t.isSlaBreached(at(27))).toBe(true);
  });
});

describe('Ticket: cliente', () => {
  it('responder cuando se esperaba su respuesta lo devuelve a la cola', () => {
    const t = newTicket();
    t.reply('¿Me confirmas la dirección?', AGENT, 'pending_customer', at(1));
    t.customerReply('Av. Amazonas N34', CUSTOMER, at(2));
    expect(t.toJSON().status).toBe('in_progress');
    const unassigned = newTicket();
    unassigned.changeStatus('pending_customer', AGENT);
    unassigned.assign(null, AGENT);
    unassigned.customerReply('Hola', CUSTOMER);
    expect(unassigned.toJSON().status).toBe('open');
  });

  it('responder un ticket resuelto lo reabre; uno cerrado no admite mensajes', () => {
    const t = newTicket();
    t.reply('Resuelto', AGENT, 'resolved', at(1));
    t.customerReply('Sigue sin llegar', CUSTOMER, at(2));
    expect(t.toJSON()).toMatchObject({ status: 'in_progress', resolvedAt: null });
    t.changeStatus('resolved', AGENT, at(3));
    t.changeStatus('closed', AGENT, at(4));
    expect(() => t.customerReply('Hola', CUSTOMER)).toThrow('abre uno nuevo');
  });

  it('CSAT: solo cerrado, de 1 a 5 y una sola vez', () => {
    const t = newTicket();
    expect(() => t.rate(5, null)).toThrow('cuando el ticket está cerrado');
    t.changeStatus('resolved', AGENT);
    t.changeStatus('closed', AGENT);
    expect(() => t.rate(6, null)).toThrow('de 1 a 5');
    expect(() => t.rate(2.5, null)).toThrow('de 1 a 5');
    t.rate(4, '  Rápidos  ', at(5));
    expect(t.toJSON()).toMatchObject({ csat: 4, csatComment: 'Rápidos', csatAt: at(5) });
    expect(() => t.rate(5, null)).toThrow('Ya respondiste');
  });
});

describe('SLA y cierre automático', () => {
  it('alerta una sola vez, solo en open/in_progress y al vencer', () => {
    const t = newTicket({ priority: 'urgent' });
    expect(t.markSlaBreached(at(3.9))).toBe(false);
    expect(t.markSlaBreached(at(4))).toBe(true);
    expect(t.markSlaBreached(at(5))).toBe(false);

    const waiting = newTicket({ priority: 'urgent' });
    waiting.changeStatus('pending_customer', AGENT);
    expect(waiting.isSlaBreached(at(10))).toBe(false);
    const resolved = newTicket({ priority: 'urgent' });
    resolved.changeStatus('resolved', AGENT);
    expect(resolved.isSlaBreached(at(10))).toBe(false);
  });

  it('autoClose solo cierra tickets resueltos', () => {
    const t = newTicket();
    expect(t.autoClose(at(1))).toBe(false);
    t.changeStatus('resolved', AGENT, at(1));
    expect(t.autoClose(at(80))).toBe(true);
    expect(t.toJSON()).toMatchObject({ status: 'closed', closedAt: at(80) });
    expect(t.newMessages.at(-1)!.body).toContain('Cerrado automáticamente');
  });
});

describe('enlace firmado', () => {
  const SECRET = 'secreto';

  it('ida y vuelta; vence; rechaza firmas alteradas', () => {
    const token = signTicketAccess(SECRET, 't1', 'tk1', 30, T0);
    expect(verifyTicketAccess(SECRET, token, at(24))).toMatchObject({ tid: 't1', tk: 'tk1' });
    expect(() => verifyTicketAccess(SECRET, token, at(24 * 31))).toThrow('venció');
    expect(() => verifyTicketAccess('otro', token, T0)).toThrow('no es válido');
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, tid: 't1', tk: 'otro', exp: 9_999_999_999 })).toString('base64url');
    expect(() => verifyTicketAccess(SECRET, `${forged}.${sig}`, T0)).toThrow('no es válido');
    expect(() => verifyTicketAccess(SECRET, `${payload}`, T0)).toThrow('no es válido');
    expect(() => verifyTicketAccess(SECRET, `${token}.x`, T0)).toThrow('no es válido');
  });
});

describe('eventos', () => {
  it('el ticket interno no lleva destinatario; el de invitado sí, con su contacto', () => {
    const system = newTicket({ createdBy: 'system', requesterId: null, channel: 'internal' });
    expect(requesterOf(system.toJSON())).toBeNull();
    expect(ticketCreated(system.toJSON(), 'system', null).payload).toMatchObject({ requester: null, accessToken: null, number: '7' });

    const guest = newTicket({ requesterId: null, requesterContact: { email: 'ana@example.test', name: 'Ana Pérez', phone: '0991234567' } });
    guest.changeStatus('resolved', AGENT, at(1));
    guest.changeStatus('closed', AGENT, at(2));
    expect(ticketClosed(guest.toJSON(), 'staff', 'tok').payload).toMatchObject({
      closedBy: 'staff',
      closedAt: at(2).toISOString(),
      accessToken: 'tok',
      requester: { userId: null, email: 'ana@example.test', name: 'Ana Pérez', phone: '0991234567' },
    });
  });
});
