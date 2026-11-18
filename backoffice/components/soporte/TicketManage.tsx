'use client';

import { useId, useState } from 'react';
import { useCan } from '@/components/providers/AuthProvider';
import { Modal } from '@/components/ui/Modal';
import { fullName } from '@/lib/format';
import {
  CATEGORY_LABELS,
  PRIORITY_MAP,
  STATUS_MAP,
  statusOptions,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  type TicketCategory,
  type TicketDetail,
  type TicketPriority,
  type TicketStatus,
} from '@/lib/support';
import type { useAgents } from './hooks';
import { useTicketAction } from './useTicketAction';

interface Changes {
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: TicketCategory;
  expectedVersion: number;
}

/**
 * Gestión: estado, prioridad (recalcula el SLA) y categoría en un solo PATCH con la versión leída.
 * El formulario se reinicia cuando el ticket cambia de versión (key en el padre).
 */
export function TicketFields({ ticket }: { ticket: TicketDetail }) {
  const id = useId();
  const [status, setStatus] = useState(ticket.status);
  const [priority, setPriority] = useState(ticket.priority);
  const [category, setCategory] = useState(ticket.category);
  const [confirmClose, setConfirmClose] = useState(false);
  const update = useTicketAction<Changes>(ticket.id, (v) => ({ path: '', method: 'PATCH', body: v }), 'Ticket actualizado');

  const closed = ticket.status === 'closed';
  const changes: Changes = { expectedVersion: ticket.version };
  if (status !== ticket.status) changes.status = status;
  if (priority !== ticket.priority) changes.priority = priority;
  if (category !== ticket.category) changes.category = category;
  const dirty = Object.keys(changes).length > 1;

  function save() {
    update.mutate(changes, { onSettled: () => setConfirmClose(false) });
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        // Cerrar es definitivo (no admite más mensajes y envía la encuesta): se confirma.
        if (changes.status === 'closed') setConfirmClose(true);
        else save();
      }}
    >
      <div>
        <label className="label" htmlFor={`${id}-status`}>
          Estado
        </label>
        <select id={`${id}-status`} className="input" value={status} disabled={closed} onChange={(e) => setStatus(e.target.value as TicketStatus)}>
          {statusOptions(ticket.status).map((s) => (
            <option key={s} value={s}>
              {STATUS_MAP[s][0]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor={`${id}-priority`}>
          Prioridad
        </label>
        <select id={`${id}-priority`} className="input" value={priority} disabled={closed} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
          {TICKET_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_MAP[p][0]}
            </option>
          ))}
        </select>
        {priority !== ticket.priority && <p className="mt-1 text-[11px] text-ink-soft">El SLA se recalcula desde la creación del ticket.</p>}
      </div>
      <div>
        <label className="label" htmlFor={`${id}-category`}>
          Categoría
        </label>
        <select id={`${id}-category`} className="input" value={category} disabled={closed} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
          {TICKET_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </div>
      {!closed && (
        <button type="submit" className="btn-primary w-full" disabled={!dirty || update.isPending}>
          {update.isPending ? 'Guardando…' : 'Guardar cambios'}
        </button>
      )}

      <Modal
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="¿Cerrar el ticket?"
        size="sm"
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setConfirmClose(false)}>
              Cancelar
            </button>
            <button type="button" className="btn-primary" onClick={save} disabled={update.isPending}>
              {update.isPending ? 'Cerrando…' : 'Cerrar ticket'}
            </button>
          </>
        }
      >
        <p className="text-sm">Un ticket cerrado ya no admite mensajes ni cambios, y se envía al cliente la encuesta de satisfacción.</p>
      </Modal>
    </form>
  );
}

/**
 * Asignación: "Tomar" (support.tickets.write) y, con support.tickets.assign, reasignar a otro agente
 * (lista de GET /iam/users si además tiene iam.users.read) o dejarlo sin asignar.
 */
export function TicketAssignee({ ticket, agents }: { ticket: TicketDetail; agents: ReturnType<typeof useAgents> }) {
  const id = useId();
  const can = useCan();
  const [agentId, setAgentId] = useState('');
  const take = useTicketAction<number>(ticket.id, (v) => ({ path: '/take', method: 'POST', body: { expectedVersion: v } }), 'Ahora el ticket es tuyo');
  const assign = useTicketAction<{ agentId: string | null; expectedVersion: number }>(
    ticket.id,
    (v) => ({ path: '/assignee', method: 'PUT', body: v }),
    'Asignación actualizada',
  );

  const closed = ticket.status === 'closed';
  const mine = ticket.assignedTo === agents.meId;
  const canWrite = can('support.tickets.write');
  const canAssign = can('support.tickets.assign');
  const busy = take.isPending || assign.isPending;
  const others = agents.agents.filter((a) => a.id !== ticket.assignedTo);

  return (
    <div className="space-y-3">
      <p className="text-sm">
        <span className="text-ink-soft">Asignado a: </span>
        <span className="font-medium">{agents.name(ticket.assignedTo)}</span>
      </p>
      {!closed && (
        <div className="flex flex-wrap gap-2">
          {canWrite && !mine && (!ticket.assignedTo || canAssign) && (
            <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => take.mutate(ticket.version)}>
              Tomar
            </button>
          )}
          {canAssign && ticket.assignedTo && (
            <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => assign.mutate({ agentId: null, expectedVersion: ticket.version })}>
              Quitar asignación
            </button>
          )}
        </div>
      )}
      {!closed && canAssign && agents.available && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (agentId) assign.mutate({ agentId, expectedVersion: ticket.version }, { onSuccess: () => setAgentId('') });
          }}
        >
          <label className="sr-only" htmlFor={`${id}-agent`}>
            Asignar a otro agente
          </label>
          <select id={`${id}-agent`} className="input py-1 text-sm" value={agentId} required onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Asignar a…</option>
            {others.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id === agents.meId ? 'Yo' : fullName(a.firstName, a.lastName) || a.email}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-ghost btn-sm" disabled={busy || !agentId}>
            Asignar
          </button>
        </form>
      )}
      {!closed && canAssign && !agents.available && (
        <p className="text-[11px] text-ink-soft">Para elegir otro agente tu rol necesita ver usuarios (iam.users.read).</p>
      )}
    </div>
  );
}
