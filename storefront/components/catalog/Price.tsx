import { discountPercent, formatMoney } from '@/lib/format';

export function Price({ price, compareAt, size = 'md' }: { price: string; compareAt?: string | null; size?: 'md' | 'lg' }) {
  const off = discountPercent(price, compareAt);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span className={`${size === 'lg' ? 'text-2xl' : 'text-base'} font-semibold ${off ? 'text-accent-dark' : ''}`}>{formatMoney(price)}</span>
      {off !== null && (
        <>
          <span className="text-sm text-ink-soft line-through" aria-label={`Antes ${formatMoney(compareAt)}`}>
            {formatMoney(compareAt)}
          </span>
          <span className="rounded bg-accent/10 px-1.5 text-xs font-semibold text-accent-dark">-{off}%</span>
        </>
      )}
    </span>
  );
}
