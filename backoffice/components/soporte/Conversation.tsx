import { formatDateTime } from '@/lib/format';
import { messageKind, systemText, type TicketDetail } from '@/lib/support';

/**
 * Conversación del ticket. Cliente a la izquierda, respuestas del agente a la derecha (salieron por
 * email), notas internas en ámbar con borde punteado y la marca "no visible para el cliente", y
 * eventos del sistema como líneas centradas.
 */
export function Conversation({ ticket, agentName, customerName }: { ticket: TicketDetail; agentName: (id: string | null) => string; customerName: string }) {
  if (ticket.messages.length === 0) return <p className="text-sm text-ink-soft">Sin mensajes.</p>;
  return (
    <ol className="space-y-3" aria-label="Conversación">
      {ticket.messages.map((m, i) => {
        const kind = messageKind(m);
        const key = m.id ?? `${m.createdAt}-${i}`;
        const when = <time dateTime={m.createdAt}>{formatDateTime(m.createdAt)}</time>;

        if (kind === 'system') {
          return (
            <li key={key} className="flex items-center gap-3 text-[11px] text-ink-soft">
              <span className="h-px flex-1 bg-line" aria-hidden />
              <span className="text-center">
                {systemText(m.body).replace(/^Asignado al agente ([0-9a-f-]{36})$/i, (_s, id: string) => `Asignado a ${agentName(id)}`)}
                {m.authorId && ` · ${agentName(m.authorId)}`} · {when}
              </span>
              <span className="h-px flex-1 bg-line" aria-hidden />
            </li>
          );
        }

        if (kind === 'note') {
          return (
            <li key={key} className="ml-auto max-w-[min(100%,40rem)] rounded-lg border border-dashed border-warn/60 bg-warn/5 px-4 py-3">
              <p className="mb-1 flex flex-wrap items-center gap-x-2 text-xs">
                <span className="font-semibold text-warn">🔒 Nota interna</span>
                <span className="text-ink-soft">no visible para el cliente</span>
                <span className="text-ink-soft">· {agentName(m.authorId)} · {when}</span>
              </p>
              <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
            </li>
          );
        }

        const agent = kind === 'agent';
        return (
          <li key={key} className={`max-w-[min(100%,40rem)] rounded-lg border px-4 py-3 ${agent ? 'ml-auto border-accent/30 bg-panel' : 'mr-auto border-line bg-sand'}`}>
            <p className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-soft">
              <span className="font-semibold text-ink">{agent ? agentName(m.authorId) : customerName}</span>
              <span>{agent ? 'Respuesta al cliente (enviada por email)' : 'Cliente'}</span>
              <span>· {when}</span>
            </p>
            <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
            {m.attachments.length > 0 && <p className="mt-2 text-xs text-ink-soft">{m.attachments.length} adjunto(s)</p>}
          </li>
        );
      })}
    </ol>
  );
}
