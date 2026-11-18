'use client';

import { useId, useState } from 'react';
import { BODY_MAX, hasRequester, replyStatusOptions, STATUS_MAP, type ReplyStatus, type TicketDetail } from '@/lib/support';
import { useTicketAction } from './useTicketAction';

type Mode = 'reply' | 'note';

/**
 * Responder al cliente (sale por email y deja el ticket en el estado elegido) o agregar una nota
 * interna. Un ticket sin cliente (interno) solo admite notas; uno cerrado, nada.
 */
export function Composer({ ticket }: { ticket: TicketDetail }) {
  const id = useId();
  const canReply = hasRequester(ticket);
  const [mode, setMode] = useState<Mode>(canReply ? 'reply' : 'note');
  const [body, setBody] = useState('');
  const [then, setThen] = useState<ReplyStatus>('pending_customer');

  const reply = useTicketAction<{ body: string; status: ReplyStatus; expectedVersion: number }>(
    ticket.id,
    (v) => ({ path: '/replies', method: 'POST', body: v }),
    'Respuesta enviada al cliente',
  );
  const note = useTicketAction<{ body: string }>(ticket.id, (v) => ({ path: '/notes', method: 'POST', body: v }), 'Nota interna agregada');

  if (ticket.status === 'closed') {
    return <p className="rounded-lg border border-line bg-sand px-4 py-3 text-sm text-ink-soft">El ticket está cerrado: ya no admite mensajes. Si el cliente necesita más ayuda, se abre uno nuevo.</p>;
  }

  const busy = reply.isPending || note.isPending;
  const text = body.trim();
  const isNote = mode === 'note';

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text) return;
    const done = { onSuccess: () => setBody('') };
    if (isNote) note.mutate({ body: text }, done);
    else reply.mutate({ body: text, status: then, expectedVersion: ticket.version }, done);
  }

  return (
    <form onSubmit={submit} className={`rounded-lg border p-3 ${isNote ? 'border-dashed border-warn/60 bg-warn/5' : 'border-line bg-panel'}`}>
      <div role="tablist" aria-label="Tipo de mensaje" className="mb-2 flex gap-1">
        <button
          type="button"
          role="tab"
          aria-selected={!isNote}
          disabled={!canReply}
          onClick={() => setMode('reply')}
          className={`rounded px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${!isNote ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'}`}
          title={canReply ? undefined : 'El ticket no tiene cliente: usa una nota interna'}
        >
          Responder al cliente
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isNote}
          onClick={() => setMode('note')}
          className={`rounded px-2.5 py-1 text-xs font-medium ${isNote ? 'bg-warn text-white' : 'text-ink-soft hover:text-ink'}`}
        >
          🔒 Nota interna
        </button>
      </div>
      <label className="sr-only" htmlFor={`${id}-body`}>
        {isNote ? 'Nota interna' : 'Respuesta al cliente'}
      </label>
      <textarea
        id={`${id}-body`}
        className="input min-h-28 resize-y"
        required
        maxLength={BODY_MAX}
        placeholder={isNote ? 'Solo la ve el equipo. El cliente nunca la recibe.' : 'Se envía por email al cliente.'}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        {isNote ? (
          <p className="text-xs text-warn">No visible para el cliente</p>
        ) : (
          <div className="flex items-center gap-2">
            <label className="text-xs text-ink-soft" htmlFor={`${id}-then`}>
              Dejar el ticket en
            </label>
            <select id={`${id}-then`} className="input w-auto py-1 text-xs" value={then} onChange={(e) => setThen(e.target.value as ReplyStatus)}>
              {replyStatusOptions(ticket.status).map((s) => (
                <option key={s} value={s}>
                  {STATUS_MAP[s][0]}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-ink-soft tabular-nums">
            {body.length}/{BODY_MAX}
          </span>
          <button type="submit" className={isNote ? 'btn-ghost' : 'btn-accent'} disabled={busy || !text}>
            {busy ? 'Enviando…' : isNote ? 'Agregar nota' : 'Enviar respuesta'}
          </button>
        </div>
      </div>
    </form>
  );
}
