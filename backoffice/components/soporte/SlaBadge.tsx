import { Badge } from '@/components/ui/Badge';
import { formatDateTime } from '@/lib/format';
import { slaState, type Ticket } from '@/lib/support';

/** Indicador del SLA: color + icono + texto (nunca solo color), con la fecha exacta al pasar el mouse. */
export function SlaBadge({ ticket, now }: { ticket: Pick<Ticket, 'status' | 'slaDueAt' | 'createdAt'>; now: Date }) {
  const s = slaState(ticket, now);
  const icon = s.tone === 'danger' ? '⚠ ' : s.tone === 'warn' ? '⏱ ' : '';
  return (
    <span title={`Vencimiento del SLA: ${formatDateTime(ticket.slaDueAt)}`}>
      <Badge tone={s.tone}>
        {icon}
        {s.label}
      </Badge>
    </span>
  );
}
