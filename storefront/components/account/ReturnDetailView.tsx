'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage, isApiError } from '@/lib/api/client';
import { formatDate, formatMoney } from '@/lib/format';
import {
  type CustomerReturnDetail,
  RESOLUTION_LABEL,
  RETURN_REASON_LABEL,
  RETURN_STATUS_HINT,
  RETURN_STATUS_LABEL,
  RETURN_TYPE_LABEL,
} from '@/lib/returns';
import { returnStatusClass } from './ReturnsList';

/** Detalle de una devolución propia (GET /me/returns/:id); una ajena responde 404. */
export function ReturnDetailView({ returnId }: { returnId: string }) {
  const [ret, setRet] = useState<CustomerReturnDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<CustomerReturnDetail>(`/me/returns/${returnId}`)
      .then(setRet)
      .catch((e) => setError(isApiError(e) && e.status === 404 ? 'No encontramos esta devolución.' : errorMessage(e)));
  }, [returnId]);

  if (error) return <p className="text-ink-soft">{error}</p>;
  if (!ret) return <p className="text-ink-soft">Cargando devolución…</p>;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/mi-cuenta/devoluciones" className="text-sm text-ink-soft hover:underline">
          ← Mis devoluciones
        </Link>
        <h1 className="mt-1 text-3xl">{ret.rmaNumber}</h1>
        <p className="text-sm text-ink-soft">
          {RETURN_TYPE_LABEL[ret.type]} del{' '}
          <Link href={`/mi-cuenta/pedidos/${ret.orderId}`} className="underline">
            pedido #{ret.order.orderNumber}
          </Link>{' '}
          · {formatDate(ret.createdAt, { dateStyle: 'long', timeStyle: 'short' })}
        </p>
      </div>

      <div className="card space-y-1 p-4 text-sm">
        <p>
          Estado: <span className={`chip ${returnStatusClass(ret.status)}`}>{RETURN_STATUS_LABEL[ret.status] ?? ret.status}</span>
        </p>
        <p className="text-ink-soft">{RETURN_STATUS_HINT[ret.status]}</p>
        {ret.type === 'return' && <p>Reembolso: {RESOLUTION_LABEL[ret.resolution]}</p>}
        {ret.refundAmount && <p>Monto a reembolsar: {formatMoney(ret.refundAmount)}</p>}
        <p className="text-ink-soft">
          {ret.returnShippingPaidBy === 'store' ? 'El retiro corre por cuenta de la tienda.' : 'El costo del retiro corre por tu cuenta.'}
        </p>
        {ret.customerNotes && <p className="text-ink-soft">Tus comentarios: {ret.customerNotes}</p>}
      </div>

      <ul className="card divide-y divide-line">
        {ret.lines.map((l) => (
          <li key={l.returnItemId} className="p-4 text-sm">
            <p className="font-medium">{l.productName}</p>
            <p className="text-xs text-ink-soft">
              {[l.colorName, l.sizeCode && `Talla ${l.sizeCode}`, `Cantidad ${l.quantity}`, RETURN_REASON_LABEL[l.reasonCode] ?? l.reasonCode].filter(Boolean).join(' · ')}
            </p>
            {l.photos.length > 0 && <p className="text-xs text-ink-soft">{l.photos.length === 1 ? '1 foto adjunta' : `${l.photos.length} fotos adjuntas`}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
