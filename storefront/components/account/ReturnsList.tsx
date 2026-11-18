import Link from 'next/link';
import { formatDate, formatMoney } from '@/lib/format';
import { type CustomerReturn, RESOLUTION_LABEL, RETURN_STATUS_HINT, RETURN_STATUS_LABEL, RETURN_TYPE_LABEL, type ReturnStatus } from '@/lib/returns';

export function returnStatusClass(status: ReturnStatus): string {
  if (status === 'rejected') return 'text-danger';
  if (status === 'refunded' || status === 'exchanged' || status === 'closed') return 'text-ok';
  return '';
}

/** Devoluciones de un pedido o de la cuenta: RMA, tipo, estado y qué sigue. Cada una abre su detalle. */
export function ReturnsList({ returns }: { returns: CustomerReturn[] }) {
  return (
    <ul className="space-y-3">
      {returns.map((r) => (
        <li key={r.id}>
          <Link href={`/mi-cuenta/devoluciones/${r.id}`} className="card flex flex-wrap items-center justify-between gap-3 p-4 hover:border-ink">
            <div>
              <p className="font-medium">{r.rmaNumber}</p>
              <p className="text-xs text-ink-soft">
                {formatDate(r.createdAt)} · {RETURN_TYPE_LABEL[r.type]}
                {r.type === 'return' && ` · ${RESOLUTION_LABEL[r.resolution]}`}
                {r.refundAmount && ` · ${formatMoney(r.refundAmount)}`}
              </p>
              <p className="mt-1 text-xs text-ink-soft">{RETURN_STATUS_HINT[r.status]}</p>
            </div>
            <span className={`chip ${returnStatusClass(r.status)}`}>{RETURN_STATUS_LABEL[r.status] ?? r.status}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
