export function Spinner({ label = 'Cargando…' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink-soft" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-ink" aria-hidden />
      {label}
    </span>
  );
}
