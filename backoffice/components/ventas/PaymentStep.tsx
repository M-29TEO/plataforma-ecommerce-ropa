'use client';

import { billingErrors, ID_TYPE_LABEL, PAYMENT_METHOD_OPTIONS, type AssistedDraft, type AssistedQuote, type BillingForm, type IdType } from '@/lib/assisted';
import { formatMoney } from '@/lib/format';
import { Field } from './CustomerStep';
import type { DraftPatch } from './useAssistedDraft';

/** Paso 4: cupón, método de pago, datos de factura (consumidor final o con cédula/RUC) y notas. */
export function PaymentStep({ draft, update, quote, showErrors }: { draft: AssistedDraft; update: (p: DraftPatch) => void; quote: AssistedQuote | undefined; showErrors: boolean }) {
  const code = draft.couponCode.trim().toUpperCase();
  const coupon = code ? quote?.coupons.find((c) => c.code.toUpperCase() === code) : undefined;
  const errors = billingErrors(draft.billing);
  const err = (k: keyof BillingForm) => (showErrors || draft.billing[k] !== '' ? errors[k] : undefined);
  const setBilling = (k: keyof BillingForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    update((d) => ({ billing: { ...d.billing, [k]: e.target.value } }));

  return (
    <div className="space-y-5">
      <div className="max-w-sm">
        <Field id="p-coupon" label="Cupón (opcional)">
          <input
            id="p-coupon"
            className="input font-mono uppercase"
            maxLength={40}
            value={draft.couponCode}
            onChange={(e) => update({ couponCode: e.target.value })}
            autoComplete="off"
          />
        </Field>
        {coupon && (
          <p className={`mt-1 text-xs ${coupon.applied ? 'text-ok' : 'text-danger'}`} role="status">
            {coupon.applied ? `Cupón aplicado: −${formatMoney(coupon.discount)}` : (coupon.message ?? 'El cupón no aplica a este pedido.')}
          </p>
        )}
      </div>

      <fieldset className="space-y-1.5">
        <legend className="label">Método de pago</legend>
        {PAYMENT_METHOD_OPTIONS.map((m) => (
          <label key={m.value} className="flex cursor-pointer items-start gap-2 rounded-md border border-line p-2 text-sm has-[:checked]:border-ink">
            <input type="radio" name="p-method" className="mt-1" checked={draft.paymentMethod === m.value} onChange={() => update({ paymentMethod: m.value })} />
            <span>
              <span className="font-medium">{m.label}</span>
              <span className="block text-xs text-ink-soft">{m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="label">Factura</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="inline-flex items-center gap-2">
            <input type="radio" name="p-billing" checked={draft.billingMode === 'final'} onChange={() => update({ billingMode: 'final' })} />
            Consumidor final
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" name="p-billing" checked={draft.billingMode === 'id'} onChange={() => update({ billingMode: 'id' })} />
            Con cédula, RUC o pasaporte
          </label>
        </div>
        {draft.billingMode === 'id' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="b-name" label="Nombre o razón social" error={err('name')}>
              <input id="b-name" className="input" required maxLength={200} value={draft.billing.name} onChange={setBilling('name')} />
            </Field>
            <Field id="b-type" label="Tipo de identificación">
              <select id="b-type" className="input" value={draft.billing.idType} onChange={setBilling('idType')}>
                {(Object.keys(ID_TYPE_LABEL) as IdType[]).map((t) => (
                  <option key={t} value={t}>
                    {ID_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="b-id" label="Número" error={err('idNumber')}>
              <input id="b-id" className="input font-mono" required maxLength={20} value={draft.billing.idNumber} onChange={setBilling('idNumber')} />
            </Field>
            <Field id="b-email" label="Email para la factura (opcional)" error={err('email')}>
              <input id="b-email" className="input" type="email" maxLength={254} value={draft.billing.email} onChange={setBilling('email')} />
            </Field>
            <div className="sm:col-span-2">
              <Field id="b-address" label="Dirección fiscal (opcional)" error={err('address')}>
                <input id="b-address" className="input" maxLength={300} value={draft.billing.address} onChange={setBilling('address')} />
              </Field>
            </div>
          </div>
        )}
      </fieldset>

      <div>
        <label htmlFor="p-notes" className="label">
          Notas del pedido (opcional)
        </label>
        <textarea id="p-notes" className="input min-h-20" maxLength={500} value={draft.notes} onChange={(e) => update({ notes: e.target.value })} />
        <p className="mt-1 text-right text-xs text-ink-soft">{draft.notes.length}/500</p>
      </div>
    </div>
  );
}
