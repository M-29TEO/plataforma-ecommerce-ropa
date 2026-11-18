'use client';

import { CONNECTION_LABEL, type StaffConnection } from '@/lib/realtime';

const DOT: Record<StaffConnection, string> = {
  connecting: 'bg-ink-soft',
  live: 'bg-ok animate-pulse',
  reconnecting: 'bg-warn',
  forbidden: 'bg-danger',
};

/** Estado del socket del staff: "En vivo" o "Reconectando" (mientras tanto se consulta cada 30 s). */
export function ConnectionBadge({ state }: { state: StaffConnection }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-xs font-medium"
      role="status"
      title={state === 'live' ? 'Recibiendo eventos en tiempo real' : 'Actualizando por consulta cada 30 s'}
    >
      <span className={`h-2 w-2 rounded-full ${DOT[state]}`} aria-hidden />
      {CONNECTION_LABEL[state]}
    </span>
  );
}
