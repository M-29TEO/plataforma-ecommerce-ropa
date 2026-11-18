'use client';

import { useState } from 'react';
import { VariantPicker } from '@/components/scanner/VariantPicker';
import { Badge } from '@/components/ui/Badge';
import { addToCart, cartUnits, issuesFor, MAX_LINES, MAX_QTY, setLineQuantity, STOCK_ISSUE_LABEL, type AssistedDraft, type AssistedQuote } from '@/lib/assisted';
import { formatMoney } from '@/lib/format';
import { variantLabel } from '@/lib/scanner';
import type { DraftPatch } from './useAssistedDraft';

/** Paso 2: prendas por búsqueda o escaneo, carrito local y avisos de stock de la cotización. */
export function ProductsStep({ draft, update, quote }: { draft: AssistedDraft; update: (p: DraftPatch) => void; quote: AssistedQuote | undefined }) {
  const [message, setMessage] = useState('');

  return (
    <div className="space-y-4">
      <VariantPicker
        label="Código de barras, SKU o nombre de la prenda"
        onSelect={(v) => {
          if (v.status !== 'active' || (v.productStatus && v.productStatus !== 'active')) {
            setMessage(`${variantLabel(v)} no está a la venta.`);
            return;
          }
          const r = addToCart(draft.cart, v);
          setMessage(r.error ?? `Agregado: ${variantLabel(v)}`);
          if (!r.error) update({ cart: r.cart });
        }}
      />
      {message && (
        <p className="text-sm text-ink-soft" role="status">
          {message}
        </p>
      )}

      {draft.cart.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-soft">Aún no hay prendas en el pedido.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Prenda</th>
                <th className="num">Precio</th>
                <th className="num">Cantidad</th>
                <th>
                  <span className="sr-only">Quitar</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.cart.map((l) => {
                const issues = issuesFor(quote, l.variantId);
                return (
                  <tr key={l.variantId}>
                    <td>
                      <span className="block font-medium">{variantLabel(l)}</span>
                      <span className="block font-mono text-xs text-ink-soft">{l.sku}</span>
                      {issues.map((i) => (
                        <span key={i.code} className="mt-1 mr-1 inline-flex items-center gap-1 text-xs">
                          <Badge tone={STOCK_ISSUE_LABEL[i.code]?.[1] ?? 'warn'}>{STOCK_ISSUE_LABEL[i.code]?.[0] ?? i.code}</Badge>
                          {i.code === 'INSUFFICIENT_STOCK' && typeof i.available === 'number' ? `Disponibles: ${i.available}` : i.message}
                        </span>
                      ))}
                    </td>
                    <td className="num">{formatMoney(l.price)}</td>
                    <td className="num">
                      <label className="sr-only" htmlFor={`qty-${l.variantId}`}>
                        Cantidad de {variantLabel(l)}
                      </label>
                      <input
                        id={`qty-${l.variantId}`}
                        type="number"
                        className="input w-20 text-right"
                        min={1}
                        max={MAX_QTY}
                        value={l.quantity}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (n >= 1) update((d) => ({ cart: setLineQuantity(d.cart, l.variantId, n) }));
                        }}
                      />
                    </td>
                    <td className="text-right">
                      <button type="button" className="btn-ghost btn-sm" onClick={() => update((d) => ({ cart: setLineQuantity(d.cart, l.variantId, 0) }))}>
                        Quitar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-line px-3 py-2 text-xs text-ink-soft">
            {draft.cart.length} de {MAX_LINES} prendas distintas · {cartUnits(draft.cart)} unidad(es) · hasta {MAX_QTY} unidades por prenda. Precio de catálogo: el total final
            (promociones e IVA) sale de la cotización.
          </p>
        </div>
      )}
    </div>
  );
}
