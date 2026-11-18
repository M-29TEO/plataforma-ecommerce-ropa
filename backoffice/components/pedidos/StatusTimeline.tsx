import { StatusBadge } from '@/components/ui/Badge';
import { formatDateTime } from '@/lib/format';
import { ACTOR_LABEL, ORDER_STATUS, type StatusHistoryEntry } from '@/lib/orders';

/** Línea de tiempo de estados (order_status_history), del más reciente al más antiguo. */
export function StatusTimeline({ history }: { history: StatusHistoryEntry[] }) {
  const rows = [...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (rows.length === 0) return <p className="text-sm text-ink-soft">Sin cambios de estado registrados.</p>;
  return (
    <ol className="relative ml-2 border-l border-line">
      {rows.map((h, i) => (
        <li key={h.id} className="mb-4 ml-4 last:mb-0">
          <span
            className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${i === 0 ? 'bg-accent' : 'bg-line'}`}
            aria-hidden
          />
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={h.toStatus} map={ORDER_STATUS} />
            {h.fromStatus && <span className="text-xs text-ink-soft">desde {ORDER_STATUS[h.fromStatus]?.[0] ?? h.fromStatus}</span>}
          </div>
          <p className="mt-0.5 text-xs text-ink-soft">
            {formatDateTime(h.createdAt)} · {ACTOR_LABEL[h.actorType] ?? h.actorType}
          </p>
          {h.reason && <p className="mt-1 text-sm">{h.reason}</p>}
        </li>
      ))}
    </ol>
  );
}
