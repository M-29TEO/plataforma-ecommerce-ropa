export function Stars({ value, count, small = false }: { value: number; count?: number; small?: boolean }) {
  const rounded = Math.round(value * 2) / 2;
  return (
    <span className={`inline-flex items-center gap-1 ${small ? 'text-xs' : 'text-sm'}`} aria-label={`${value.toFixed(1)} de 5 estrellas`}>
      <span aria-hidden className="tracking-tight text-accent">
        {[1, 2, 3, 4, 5].map((i) => (i <= rounded ? '★' : i - 0.5 === rounded ? '⯪' : '☆')).join('')}
      </span>
      {count !== undefined && <span className="text-ink-soft">({count})</span>}
    </span>
  );
}
