'use client';

import { Badge, StatusBadge } from '@/components/ui/Badge';
import { formatMoney, formatRelative } from '@/lib/format';
import { codUsage, isOverCodLimit, isStale, type LiveRider, PRESENCE_COLOR, PRESENCE_LABEL } from '@/lib/logistics';

/** Saldo de efectivo contra entrega frente a su límite, con alerta si lo supera. */
export function CodMeter({ rider }: { rider: Pick<LiveRider, 'codBalance' | 'codLimit'> }) {
  const over = isOverCodLimit(rider);
  const usage = codUsage(rider);
  const pct = Math.min(100, Math.round((Number.isFinite(usage) ? usage : 1) * 100));
  return (
    <div className="mt-1.5">
      <div className="flex items-center justify-between text-[11px] text-ink-soft">
        <span>
          Efectivo {formatMoney(rider.codBalance)} / {formatMoney(rider.codLimit)}
        </span>
        {over && <span className="font-semibold text-danger">⚠ Supera el límite</span>}
      </div>
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-sand" aria-hidden>
        <div className={`h-full rounded-full ${over ? 'bg-danger' : pct >= 80 ? 'bg-warn' : 'bg-ink-soft/60'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Tarjeta de un motorizado en la lista lateral del mapa. */
export function RiderRow({ rider, selected, onSelect, now }: { rider: LiveRider; selected: boolean; onSelect: () => void; now: number }) {
  const stale = isStale(rider.lastLocation, now);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${selected ? 'border-ink bg-sand/60' : 'border-line bg-panel hover:border-ink-soft'}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PRESENCE_COLOR[rider.presence] }} aria-hidden />
            <span className="truncate text-sm font-medium">{rider.name ?? 'Sin nombre'}</span>
          </span>
          <StatusBadge status={rider.presence} map={PRESENCE_LABEL} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-soft">
          {rider.plate && <span>{rider.plate}</span>}
          <span className={stale ? 'text-warn' : ''}>{rider.lastLocation ? `Posición ${formatRelative(rider.lastLocation.recordedAt, new Date(now))}` : 'Sin posición'}</span>
          {rider.activeShipments.length > 0 && <Badge tone="accent">{rider.activeShipments.length} envío(s)</Badge>}
        </div>
        <CodMeter rider={rider} />
      </button>
    </li>
  );
}
