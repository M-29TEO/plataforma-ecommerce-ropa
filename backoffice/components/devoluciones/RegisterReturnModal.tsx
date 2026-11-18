'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { useCan } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/providers/ToastProvider';
import { searchVariants } from '@/components/scanner/variant-cache';
import { Modal } from '@/components/ui/Modal';
import { api, errorMessage } from '@/lib/api/client';
import { formatMoney } from '@/lib/format';
import type { OrderDetail, OrderItem } from '@/lib/orders';
import {
  buildRegisterBody,
  type DraftLine,
  emptyDraft,
  NOTES_MAX,
  REASON_LABEL,
  REASON_MAX,
  RESOLUTION_LABEL,
  RETURN_REASON_CODES,
  type RefundResolution,
  type ReturnDetail,
  type ReturnDraft,
  type ReturnReasonCode,
  type ReturnType,
  validateDraft,
} from '@/lib/returns';
import { variantLabel } from '@/lib/scanner';

/** Permisos con los que el catálogo busca variantes (VARIANT_LOOKUP_PERMISSIONS del backend). */
const VARIANT_LOOKUP = ['inventory.read', 'catalog.product.write', 'orders.assisted.create', 'inventory.picking'];

const EMPTY_LINE: DraftLine = { quantity: 0, reasonCode: '', exchangeVariantId: '' };

/**
 * Otra talla del mismo producto para un cambio: se buscan las variantes por nombre
 * (GET /catalog/variants/lookup?q=) y se dejan las del mismo producto, activas y distintas de la comprada.
 */
function ExchangeVariantSelect({ item, value, onChange }: { item: OrderItem; value: string; onChange: (id: string) => void }) {
  const q = useQuery({
    queryKey: ['catalog', 'variants', 'exchange', item.productId],
    queryFn: async ({ signal }) => (await searchVariants(item.productName, signal)).filter((v) => v.productId === item.productId && v.variantId !== item.variantId && v.status === 'active'),
    staleTime: 60_000,
  });
  if (q.isPending) return <p className="text-xs text-ink-soft">Buscando tallas…</p>;
  if (q.error) return <p className="text-xs text-danger">{errorMessage(q.error)}</p>;
  if (q.data.length === 0) return <p className="text-xs text-warn">No hay otras tallas a la venta de este producto.</p>;
  return (
    <select className="input" aria-label={`Talla nueva de ${item.productName}`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Talla nueva…</option>
      {q.data.map((v) => (
        <option key={v.variantId} value={v.variantId}>
          {variantLabel(v)} ({v.sku})
        </option>
      ))}
    </select>
  );
}

/**
 * Soporte registra la devolución o el cambio en nombre del cliente (POST /returns): por ejemplo un
 * invitado que llama. Queda "solicitada", como la del cliente, y luego se aprueba en su ficha.
 * Sin fotos: las adjunta el cliente desde su cuenta.
 */
export function RegisterReturnModal({ order, available, onClose }: { order: OrderDetail; available: ReadonlyMap<string, number>; onClose: () => void }) {
  const id = useId();
  const can = useCan();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ReturnDraft>(emptyDraft);
  const [tried, setTried] = useState(false);
  const canLookup = VARIANT_LOOKUP.some(can);
  const { errors, warnings } = validateDraft(draft, available);

  const create = useMutation({
    mutationFn: () => api<ReturnDetail>('/returns', { method: 'POST', body: buildRegisterBody(order.id, draft) }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['returns'] });
      toast.ok(`Devolución ${r.rmaNumber} registrada`);
      onClose();
      router.push(`/devoluciones/${r.id}`);
    },
  });

  const line = (itemId: string) => draft.lines[itemId] ?? EMPTY_LINE;
  const setLine = (itemId: string, patch: Partial<DraftLine>) => setDraft((d) => ({ ...d, lines: { ...d.lines, [itemId]: { ...line(itemId), ...patch } } }));
  const setType = (type: ReturnType) => setDraft((d) => ({ ...d, type }));

  function submit() {
    setTried(true);
    if (errors.length === 0) create.mutate();
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={`Registrar devolución · pedido #${order.orderNumber ?? order.id.slice(0, 8)}`}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={create.isPending}>
            Cancelar
          </button>
          <button className="btn-primary" onClick={submit} disabled={create.isPending || (tried && errors.length > 0)}>
            {create.isPending ? 'Registrando…' : 'Registrar devolución'}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <fieldset>
          <legend className="label">Tipo</legend>
          <div className="flex flex-wrap gap-4">
            <label className="inline-flex items-center gap-2">
              <input type="radio" name={`${id}-type`} checked={draft.type === 'return'} onChange={() => setType('return')} />
              Devolución (reembolso)
            </label>
            <label className="inline-flex items-center gap-2" title={canLookup ? undefined : 'Tu rol no puede consultar las tallas del catálogo'}>
              <input type="radio" name={`${id}-type`} checked={draft.type === 'exchange'} disabled={!canLookup} onChange={() => setType('exchange')} />
              Cambio por otra talla
            </label>
          </div>
          {!canLookup && <p className="mt-1 text-xs text-ink-soft">Para registrar un cambio de talla hace falta consultar el catálogo (rol de bodega, ventas o administración).</p>}
        </fieldset>

        {draft.type === 'return' && (
          <div>
            <label className="label" htmlFor={`${id}-resolution`}>
              Resolución
            </label>
            <select id={`${id}-resolution`} className="input max-w-sm" value={draft.resolution} onChange={(e) => setDraft((d) => ({ ...d, resolution: e.target.value as RefundResolution }))}>
              <option value="refund_original">{RESOLUTION_LABEL.refund_original}</option>
              <option value="store_credit">{RESOLUTION_LABEL.store_credit}</option>
            </select>
          </div>
        )}

        <div className="-mx-5 overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Comprado</th>
                <th className="num">Devolvible</th>
                <th>Cantidad</th>
                <th>Motivo</th>
                {draft.type === 'exchange' && <th>Talla nueva</th>}
              </tr>
            </thead>
            <tbody>
              {order.items.map((i) => {
                const max = available.get(i.id) ?? 0;
                const l = line(i.id);
                return (
                  <tr key={i.id} className={max === 0 ? 'opacity-60' : undefined}>
                    <td className="max-w-64">
                      <span className="block font-medium">{i.productName}</span>
                      <span className="block text-xs text-ink-soft">
                        {[i.colorName, i.sizeCode].filter(Boolean).join(' · ')} · <span className="font-mono">{i.sku}</span> · {formatMoney(i.unitPrice)}
                      </span>
                    </td>
                    <td className="num">{i.quantity}</td>
                    <td className="num">{max}</td>
                    <td>
                      <input
                        type="number"
                        className="input w-20"
                        aria-label={`Cantidad a devolver de ${i.productName}`}
                        min={0}
                        max={max}
                        step={1}
                        disabled={max === 0}
                        value={l.quantity}
                        onChange={(e) => setLine(i.id, { quantity: Math.max(0, Math.min(max, Math.trunc(Number(e.target.value) || 0))) })}
                      />
                    </td>
                    <td>
                      <select
                        className="input"
                        aria-label={`Motivo de ${i.productName}`}
                        disabled={l.quantity === 0}
                        value={l.reasonCode}
                        onChange={(e) => setLine(i.id, { reasonCode: e.target.value as ReturnReasonCode | '' })}
                      >
                        <option value="">Motivo…</option>
                        {RETURN_REASON_CODES.map((c) => (
                          <option key={c} value={c}>
                            {REASON_LABEL[c]}
                          </option>
                        ))}
                      </select>
                    </td>
                    {draft.type === 'exchange' && (
                      <td className="min-w-48">
                        {l.quantity > 0 ? <ExchangeVariantSelect item={i} value={l.exchangeVariantId} onChange={(v) => setLine(i.id, { exchangeVariantId: v })} /> : null}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor={`${id}-reason`}>
              Motivo general (opcional)
            </label>
            <textarea
              id={`${id}-reason`}
              className="input"
              rows={2}
              maxLength={REASON_MAX}
              placeholder="Si falta, se arma con los motivos de cada producto"
              value={draft.reason}
              onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
            />
          </div>
          <div>
            <label className="label" htmlFor={`${id}-notes`}>
              Notas del cliente (opcional)
            </label>
            <textarea
              id={`${id}-notes`}
              className="input"
              rows={2}
              maxLength={NOTES_MAX}
              placeholder="Lo que contó por teléfono o WhatsApp"
              value={draft.customerNotes}
              onChange={(e) => setDraft((d) => ({ ...d, customerNotes: e.target.value }))}
            />
          </div>
        </div>

        {warnings.map((w) => (
          <p key={w} className="text-warn">
            {w}
          </p>
        ))}
        {tried &&
          errors.map((e) => (
            <p key={e} className="text-danger" role="alert">
              {e}
            </p>
          ))}
        {create.error ? (
          <p className="text-danger" role="alert">
            {errorMessage(create.error)}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
