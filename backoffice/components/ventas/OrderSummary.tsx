'use client';

import { cartUnits, FULFILLMENT_OPTIONS, PAYMENT_METHOD_OPTIONS, type AssistedDraft, type QuoteTotals, type Selection } from '@/lib/assisted';
import { formatDate, formatMoney, formatTime, fullName } from '@/lib/format';
import { variantLabel } from '@/lib/scanner';

/** Resumen del pedido (columna lateral fija en escritorio y paso "Confirmar"). */
export function OrderSummary({
  draft,
  totals,
  selection,
  status,
  detailed = false,
}: {
  draft: AssistedDraft;
  totals: QuoteTotals | null;
  selection: Selection | null;
  status: React.ReactNode;
  detailed?: boolean;
}) {
  const who =
    draft.customerMode === 'registered'
      ? draft.customer
        ? fullName(draft.customer.firstName, draft.customer.lastName)
        : null
      : draft.guest.firstName || draft.guest.lastName
        ? `${fullName(draft.guest.firstName, draft.guest.lastName)} (invitado)`
        : null;
  const fulfillment = FULFILLMENT_OPTIONS.find((o) => o.value === draft.fulfillmentType)?.label;
  const payment = PAYMENT_METHOD_OPTIONS.find((o) => o.value === draft.paymentMethod)?.label;

  return (
    <div className="space-y-3 text-sm">
      <dl className="space-y-1">
        <Row label="Cliente">{who ?? <span className="text-ink-soft">Sin elegir</span>}</Row>
        <Row label="Prendas">{draft.cart.length ? `${cartUnits(draft.cart)} unidad(es)` : <span className="text-ink-soft">Ninguna</span>}</Row>
        <Row label="Entrega">
          {selection?.option ? selection.option.label : fulfillment}
          {selection?.slot && (
            <span className="block text-xs text-ink-soft">
              {formatDate(selection.slot.startsAt)} {formatTime(selection.slot.startsAt)}
            </span>
          )}
        </Row>
        <Row label="Pago">{payment}</Row>
        {draft.couponCode.trim() && <Row label="Cupón">{draft.couponCode.trim().toUpperCase()}</Row>}
      </dl>

      {detailed && draft.cart.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {draft.cart.map((l) => (
            <li key={l.variantId} className="flex justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate">
                {l.quantity} × {variantLabel(l)}
              </span>
              <span className="shrink-0 font-mono text-xs text-ink-soft">{l.sku}</span>
            </li>
          ))}
        </ul>
      )}

      {totals && (
        <dl className="space-y-1 border-t border-line pt-3">
          <Row label="Subtotal" num>
            {formatMoney(totals.subtotal)}
          </Row>
          <Row label="Descuentos" num>
            {Number(totals.discountTotal) > 0 ? `−${formatMoney(totals.discountTotal)}` : formatMoney(0)}
          </Row>
          <Row label="Envío" num>
            {formatMoney(totals.shippingTotal)}
          </Row>
          <Row label="IVA" num>
            {formatMoney(totals.taxTotal)}
          </Row>
          <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
            <dt>Total</dt>
            <dd className="num">{formatMoney(totals.total)}</dd>
          </div>
        </dl>
      )}
      {status}
    </div>
  );
}

function Row({ label, children, num }: { label: string; children: React.ReactNode; num?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={`text-right ${num ? 'num' : ''}`}>{children}</dd>
    </div>
  );
}
