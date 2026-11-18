'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { CustomerStep } from '@/components/ventas/CustomerStep';
import { DeliveryStep } from '@/components/ventas/DeliveryStep';
import { OrderSummary } from '@/components/ventas/OrderSummary';
import { PaymentStep } from '@/components/ventas/PaymentStep';
import { ProductsStep } from '@/components/ventas/ProductsStep';
import { SuccessPanel } from '@/components/ventas/SuccessPanel';
import { useAssistedDraft } from '@/components/ventas/useAssistedDraft';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { ErrorState } from '@/components/ui/States';
import { Spinner } from '@/components/ui/Spinner';
import { api, errorMessage, isApiError } from '@/lib/api/client';
import {
  billingErrors,
  buildCreateBody,
  buildQuoteBody,
  customerFirstName,
  customerPhone,
  customerRef,
  effectiveSelection,
  fulfillmentBody,
  REQUOTE_CODES,
  resolveSelection,
  type AssistedOrderResult,
  type AssistedQuote,
  type CreateBody,
} from '@/lib/assisted';
import { formatMoney } from '@/lib/format';
import { useDebounced, useIdempotencyKey } from '@/lib/hooks';
import type { Warehouse } from '@/lib/inventory';

const STEPS = ['Cliente', 'Productos', 'Entrega', 'Pago y factura', 'Confirmar'] as const;

interface Success {
  result: AssistedOrderResult;
  phone: string | null;
  name: string;
}

/**
 * Asistente de pedido asistido: el vendedor arma el pedido a nombre del cliente. Cada cambio de
 * ítems, cliente, cupón o entrega vuelve a cotizar (con debounce); el pedido se crea con la
 * última cotización, su token de envío y el total mostrado (expectedTotal).
 */
export default function NewAssistedOrderPage() {
  const qc = useQueryClient();
  const { draft, update, reset, restored } = useAssistedDraft();
  const [idempotencyKey, renewKey] = useIdempotencyKey();
  const [showErrors, setShowErrors] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [success, setSuccess] = useState<Success | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Tiendas de retiro (el vendedor tiene inventory.read).
  const warehouses = useQuery({
    queryKey: ['ventas', 'pickup-warehouses'],
    queryFn: ({ signal }) => api<Warehouse[]>('/inventory/warehouses', { query: { active: true }, signal }),
    staleTime: 5 * 60_000,
  });
  const pickups = useMemo(() => (warehouses.data ?? []).filter((w) => w.isPickupPoint && w.active), [warehouses.data]);

  // ---------------------------------------------------------------- Cotización
  const built = useMemo(() => buildQuoteBody(draft, pickups[0]?.id ?? null), [draft, pickups]);
  const bodyKey = built ? JSON.stringify(built.body) : null;
  const debouncedKey = useDebounced(bodyKey, 500);
  const quoteQ = useQuery({
    queryKey: ['ventas', 'quote', debouncedKey],
    queryFn: ({ signal }) => api<AssistedQuote>('/assisted-orders/quote', { method: 'POST', body: JSON.parse(debouncedKey!), signal }),
    enabled: restored && !!debouncedKey && !success,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
    // El token de envío vence (validUntil): se vuelve a cotizar un poco antes.
    refetchInterval: (q) => {
      const until = q.state.data?.delivery?.validUntil;
      if (!until) return false;
      return Math.max(10_000, new Date(until).getTime() - Date.now() - 20_000);
    },
  });
  const quote = bodyKey ? quoteQ.data : undefined;
  const quoteCurrent = !!bodyKey && debouncedKey === bodyKey && !quoteQ.isPlaceholderData && !quoteQ.isFetching && !!quoteQ.data && !quoteQ.error;
  const provisional = built?.provisional ?? false;

  const chosen = effectiveSelection(quote, draft);
  const selDraft = { ...draft, ...chosen };
  const selection = quote && !provisional ? resolveSelection(quote, selDraft) : null;
  const totals = selection?.totals ?? quote?.totals ?? null;

  // ---------------------------------------------------------------- Validación por paso
  const stepError = (step: number): string | null => {
    if (step === 0) {
      if (customerRef(draft)) return null;
      if (draft.customerMode === 'registered') return draft.customer?.status === 'blocked' ? 'El cliente está bloqueado.' : 'Busca y elige un cliente.';
      return 'Completa los datos del cliente invitado.';
    }
    if (step === 1) {
      if (draft.cart.length === 0) return 'Agrega al menos una prenda.';
      if (quote && !quote.canPlace) return 'Hay prendas sin stock suficiente: ajusta las cantidades.';
      return null;
    }
    if (step === 2) {
      const f = fulfillmentBody(draft);
      if ('missing' in f) return f.missing;
      if (draft.fulfillmentType !== 'pickup') {
        if (!quoteCurrent) return 'Espera la cotización del envío.';
        if (selection?.missing) return selection.missing;
      }
      return null;
    }
    if (step === 3) {
      if (draft.billingMode === 'id' && Object.keys(billingErrors(draft.billing)).length > 0) return 'Revisa los datos de facturación.';
      return null;
    }
    return null;
  };
  const firstInvalid = [0, 1, 2, 3].find((s) => stepError(s) !== null);
  const maxReachable = firstInvalid ?? 4;
  const currentError = stepError(draft.step);

  function go(step: number) {
    if (step > draft.step && currentError) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setCreateError(null);
    update({ step: Math.min(step, maxReachable) });
  }

  // ---------------------------------------------------------------- Crear
  const create = useMutation({
    mutationFn: (body: CreateBody) => api<AssistedOrderResult>('/assisted-orders', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } }),
    onSuccess: (result) => {
      setSuccess({ result, phone: customerPhone(draft), name: customerFirstName(draft) });
      reset();
      void qc.invalidateQueries({ queryKey: ['ventas', 'assisted-orders'] });
      window.scrollTo({ top: 0 });
    },
    onError: (e) => {
      if (isApiError(e, 'CHECKOUT_TOTAL_CHANGED')) {
        const { expected, actual } = e.details as { expected?: string; actual?: string };
        setCreateError(`El total cambió de ${formatMoney(expected)} a ${formatMoney(actual)}. Revisa el resumen y confirma de nuevo.`);
      } else setCreateError(errorMessage(e) || 'No se pudo crear el pedido.');
      // El pedido no se creó (la transacción se revierte): se cotiza de nuevo para mostrar lo vigente.
      if (isApiError(e) && (REQUOTE_CODES.has(e.code) || e.status === 409 || e.status === 422)) void quoteQ.refetch();
    },
  });

  const buildResult = quote && quoteCurrent && !provisional ? buildCreateBody(selDraft, quote) : null;
  const canCreate = !!buildResult && 'body' in buildResult && !create.isPending;

  function startNew() {
    reset();
    renewKey();
    setSuccess(null);
    setCreateError(null);
    setShowErrors(false);
    create.reset();
  }

  // ---------------------------------------------------------------- Render
  if (success) {
    return (
      <div>
        <PageHeader title="Pedido asistido creado" back={{ href: '/ventas/pedidos-asistidos', label: 'Pedidos asistidos' }} />
        <SuccessPanel result={success.result} phone={success.phone} name={success.name} onNew={startNew} />
      </div>
    );
  }

  if (!restored) return <Spinner />;

  const quoteStatus = (
    <div className="text-xs">
      {!bodyKey ? (
        <p className="text-ink-soft">{draft.cart.length === 0 ? 'Agrega prendas para cotizar.' : 'Completa la entrega para cotizar.'}</p>
      ) : quoteQ.error && !quoteQ.isFetching ? (
        <ErrorState error={quoteQ.error} onRetry={() => void quoteQ.refetch()} />
      ) : !quoteCurrent ? (
        <Spinner label="Cotizando…" />
      ) : provisional ? (
        <p className="text-ink-soft">Sin envío: completa la entrega para ver el total final.</p>
      ) : (
        <p className="text-ok">Cotización vigente.</p>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Nuevo pedido asistido"
        description="Arma el pedido a nombre del cliente. El borrador se guarda en esta pestaña."
        back={{ href: '/ventas/pedidos-asistidos', label: 'Pedidos asistidos' }}
        actions={
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => setConfirmDiscard(true)}
          >
            Descartar borrador
          </button>
        }
      />

      <ol className="mb-4 flex gap-1 overflow-x-auto text-sm" aria-label="Pasos">
        {STEPS.map((label, i) => (
          <li key={label} className="shrink-0">
            <button
              type="button"
              aria-current={draft.step === i ? 'step' : undefined}
              disabled={i > maxReachable}
              onClick={() => go(i)}
              className={`rounded-md px-3 py-1.5 ${draft.step === i ? 'bg-ink text-paper' : i <= maxReachable ? 'text-ink hover:bg-sand' : 'text-ink-soft opacity-60'}`}
            >
              {i + 1}. {label}
            </button>
          </li>
        ))}
      </ol>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="card p-4" aria-label={STEPS[draft.step]}>
          <h2 className="mb-4 text-base font-semibold">{STEPS[draft.step]}</h2>

          {draft.step === 0 && <CustomerStep draft={draft} update={update} showErrors={showErrors} />}
          {draft.step === 1 && <ProductsStep draft={draft} update={update} quote={quote} />}
          {draft.step === 2 && (
            <DeliveryStep
              draft={draft}
              update={update}
              quote={quoteCurrent || quoteQ.isPlaceholderData ? quote : undefined}
              quoteLoading={!!bodyKey && !quoteCurrent && !quoteQ.error}
              quoteError={quoteQ.error && !quoteQ.isFetching ? <ErrorState error={quoteQ.error} onRetry={() => void quoteQ.refetch()} /> : null}
              pickups={pickups}
              selection={chosen}
            />
          )}
          {draft.step === 3 && <PaymentStep draft={draft} update={update} quote={quote} showErrors={showErrors} />}
          {draft.step === 4 && (
            <div className="space-y-4">
              <OrderSummary draft={selDraft} totals={totals} selection={selection} status={quoteStatus} detailed />
              {quote && quote.coupons.some((c) => !c.applied) && (
                <p className="text-sm text-danger" role="alert">
                  {quote.coupons.find((c) => !c.applied)?.message ?? 'El cupón no aplica.'} Quítalo o cámbialo en el paso de pago.
                </p>
              )}
              {buildResult && 'error' in buildResult && <p className="text-sm text-warn">{buildResult.error}</p>}
              {createError && (
                <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">
                  {createError}
                </p>
              )}
              <button
                type="button"
                className="btn-primary w-full sm:w-auto"
                disabled={!canCreate}
                onClick={() => {
                  if (buildResult && 'body' in buildResult) {
                    setCreateError(null);
                    create.mutate(buildResult.body);
                  }
                }}
              >
                {create.isPending ? 'Creando pedido…' : `Crear pedido${totals ? ` por ${formatMoney(totals.total)}` : ''}`}
              </button>
            </div>
          )}

          {showErrors && currentError && (
            <p className="mt-4 text-sm text-danger" role="alert">
              {currentError}
            </p>
          )}

          <div className="mt-6 flex justify-between gap-2 border-t border-line pt-4">
            <button type="button" className="btn-ghost" disabled={draft.step === 0} onClick={() => go(draft.step - 1)}>
              Anterior
            </button>
            {draft.step < 4 && (
              <button type="button" className="btn-primary" onClick={() => go(draft.step + 1)}>
                Siguiente
              </button>
            )}
          </div>
        </section>

        <aside className="card p-4 lg:sticky lg:top-4" aria-label="Resumen del pedido">
          <h2 className="mb-3 text-base font-semibold">Resumen</h2>
          <OrderSummary draft={selDraft} totals={totals} selection={selection} status={quoteStatus} />
        </aside>
      </div>

      <Modal
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Descartar borrador"
        size="sm"
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setConfirmDiscard(false)}>
              Volver
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => {
                setConfirmDiscard(false);
                startNew();
              }}
            >
              Descartar
            </button>
          </>
        }
      >
        <p className="text-sm">Se borrarán el cliente, las prendas y la entrega de este pedido. No se puede deshacer.</p>
      </Modal>
    </div>
  );
}
