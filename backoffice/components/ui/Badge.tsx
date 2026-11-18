export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

const TONES: Record<Tone, string> = {
  neutral: 'bg-sand text-ink-soft',
  ok: 'bg-ok/10 text-ok',
  warn: 'bg-warn/10 text-warn',
  danger: 'bg-danger/10 text-danger',
  info: 'bg-info/10 text-info',
  accent: 'bg-accent/10 text-accent-dark',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>{children}</span>;
}

/** Etiqueta de un estado con su texto en español y su color (tabla por pantalla). */
export function StatusBadge<S extends string>({ status, map }: { status: S; map: Partial<Record<S, [string, Tone]>> }) {
  const [label, tone] = map[status] ?? [status, 'neutral'];
  return <Badge tone={tone}>{label}</Badge>;
}
