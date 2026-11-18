'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useWarehouseName } from '@/components/bodega/shared';
import { useToast } from '@/components/providers/ToastProvider';
import { BarcodeScanner } from '@/components/scanner/BarcodeScanner';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryState } from '@/components/ui/States';
import { api, errorMessage, isApiError } from '@/lib/api/client';
import { formatDate, formatTime } from '@/lib/format';
import { FULFILLMENT_LABEL, ORDER_STATUS } from '@/lib/orders';
import {
  adjustPick,
  clearPicked,
  completeBody,
  type CompletePickingResult,
  loadPicked,
  type Picked,
  type PickingDetail,
  type PickingHeader,
  pickErrorLines,
  pickProgress,
  registerPick,
  sanitizePicked,
  savePicked,
} from '@/lib/picking';

type Alert = { tone: 'danger' | 'warn' | 'ok'; text: string };

function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Sin vibración (escritorio, iOS).
  }
}

/**
 * Picking de un pedido (pensado para el móvil): iniciar (pedido → preparing), escanear cada prenda
 * (suma 1 a su línea), ajustar a mano las prendas sin código y completar cuando todo está recogido.
 * El avance se guarda en sessionStorage por pedido.
 */
export default function PickingDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const warehouseName = useWarehouseName();

  const [picked, setPicked] = useState<Picked>(() => (typeof window === 'undefined' ? {} : loadPicked(orderId)));
  const [alert, setAlert] = useState<Alert | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [completeErrors, setCompleteErrors] = useState<string[]>([]);

  const q = useQuery({
    queryKey: ['fulfillment', 'picking', 'detail', orderId],
    queryFn: ({ signal }) => api<PickingDetail>(`/fulfillment/picking/${orderId}`, { signal }),
  });
  const detail = q.data;

  // Lecturas más rápidas que los renders: el conteo vigente vive en un ref.
  const pickedRef = useRef(picked);
  useEffect(() => {
    pickedRef.current = picked;
    savePicked(orderId, picked);
  }, [orderId, picked]);

  const start = useMutation({
    mutationFn: (version: number) => api<PickingHeader>(`/fulfillment/picking/${orderId}/start`, { method: 'POST', body: { version } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fulfillment', 'picking'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      toast.ok('Picking iniciado: escanea cada prenda');
    },
    onError: (e) => {
      if (isApiError(e, 'STALE_VERSION') || isApiError(e, 'INVALID_ORDER_TRANSITION')) {
        void q.refetch();
      }
      toast.error(e);
    },
  });

  const complete = useMutation({
    mutationFn: (body: ReturnType<typeof completeBody>) =>
      api<CompletePickingResult>(`/fulfillment/picking/${orderId}/complete`, { method: 'POST', body }),
    onSuccess: (r) => {
      clearPicked(orderId);
      void qc.invalidateQueries({ queryKey: ['fulfillment', 'picking'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      toast.ok(`Pedido #${r.orderNumber ?? ''} listo para ${r.fulfillmentType === 'pickup' ? 'retiro en tienda' : 'despacho'}`);
      setConfirming(false);
      router.push('/bodega/picking');
    },
    onError: (e) => {
      setConfirming(false);
      if (detail && (isApiError(e, 'PICK_EXCESS') || isApiError(e, 'PICK_INCOMPLETE'))) {
        setCompleteErrors([errorMessage(e), ...pickErrorLines(detail.items, e.details)]);
      } else {
        setCompleteErrors([errorMessage(e)]);
      }
      vibrate([300, 100, 300]);
    },
  });

  function onScan(code: string) {
    if (!detail) return;
    const r = registerPick(detail.items, pickedRef.current, code);
    if (r.kind === 'not_in_order') {
      vibrate([400, 120, 400, 120, 400]);
      setAlert({ tone: 'danger', text: `¡Esta prenda NO es de este pedido! (código ${code}). Devuélvela a su lugar.` });
      return;
    }
    if (r.kind === 'excess') {
      vibrate([200, 80, 200]);
      setAlert({ tone: 'warn', text: `Ya tienes todas las unidades de ${r.item.productName}${r.item.size ? ` talla ${r.item.size}` : ''}: esta sobra.` });
      return;
    }
    pickedRef.current = r.picked;
    setPicked(r.picked);
    setCompleteErrors([]);
    setAlert({
      tone: 'ok',
      text: `+1 ${r.item.productName}${r.item.size ? ` · ${r.item.size}` : ''}${r.item.color ? ` · ${r.item.color}` : ''} (${r.picked[r.item.orderItemId]}/${r.item.quantity})`,
    });
  }

  return (
    <QueryState query={q}>
      {(d) => {
        // Lo guardado puede tener líneas viejas (p. ej. tras una devolución): se acota al detalle actual.
        const current = sanitizePicked(d.items, picked);
        const progress = pickProgress(d.items, current);
        const started = d.status === 'preparing';
        const closed = started && d.shipmentStatus !== null && d.shipmentStatus !== 'pending';
        return (
          <div className="pb-24">
            <PageHeader
              title={`Pedido #${d.orderNumber ?? d.orderId.slice(0, 8)}`}
              back={{ href: '/bodega/picking', label: 'Cola de picking' }}
              description={
                <>
                  {FULFILLMENT_LABEL[d.fulfillmentType] ?? d.fulfillmentType} · {warehouseName(d.warehouseId)}
                  {d.deliverySlot && (
                    <>
                      {' '}
                      · franja {formatDate(d.deliverySlot.startsAt)} {formatTime(d.deliverySlot.startsAt)}–{formatTime(d.deliverySlot.endsAt)}
                    </>
                  )}
                </>
              }
              actions={<StatusBadge status={d.status} map={ORDER_STATUS} />}
            />

            {d.notes && <p className="mb-3 rounded-md bg-sand px-3 py-2 text-sm">Nota del pedido: {d.notes}</p>}

            {closed && (
              <p className="mb-3 rounded-md border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok">
                Este pedido ya se completó y está en logística ({d.shipmentStatus}).
              </p>
            )}

            {!started && (
              <div className="card mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
                <p className="text-sm">Al iniciar, el pedido pasa a “En preparación”.</p>
                <button className="btn-accent" disabled={start.isPending} onClick={() => start.mutate(d.version)}>
                  {start.isPending ? 'Iniciando…' : 'Iniciar picking'}
                </button>
              </div>
            )}

            {/* Progreso */}
            <div className="mb-4">
              <div className="mb-1 flex justify-between text-sm">
                <span>Progreso</span>
                <span className="font-semibold tabular-nums">
                  {progress.done} / {progress.total} unidades
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-sand" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
                <div className={`h-full transition-all ${progress.complete ? 'bg-ok' : 'bg-accent'}`} style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
              </div>
            </div>

            {started && !closed && (
              <section className="card mb-4 space-y-3 p-4">
                <BarcodeScanner onDetected={onScan} label="Escanea cada prenda" />
                {alert && (
                  <p
                    role="alert"
                    className={`rounded-md px-3 py-3 text-sm font-semibold ${
                      alert.tone === 'danger' ? 'animate-pulse bg-danger text-white text-base' : alert.tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-ok/10 text-ok'
                    }`}
                  >
                    {alert.text}
                  </p>
                )}
              </section>
            )}

            <ul className="space-y-2">
              {d.items.map((i) => {
                const n = current[i.orderItemId] ?? 0;
                const done = n >= i.quantity;
                return (
                  <li key={i.orderItemId} className={`card flex items-center gap-3 p-3 ${done ? 'border-ok/50 bg-ok/5' : ''}`}>
                    {i.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- fotos del catálogo (URL externa del almacén)
                      <img src={i.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded object-cover" loading="lazy" />
                    ) : (
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded bg-sand text-xs text-ink-soft">Sin foto</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{i.productName}</p>
                      <p className="text-sm">
                        {i.size && <Badge tone="neutral">Talla {i.size}</Badge>} {i.color && <span className="text-ink-soft">{i.color}</span>}
                      </p>
                      <p className="truncate font-mono text-xs text-ink-soft">
                        {i.sku}
                        {i.barcode ? ` · ${i.barcode}` : ' · sin código de barras'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-center gap-1">
                      <span className={`text-xl font-semibold tabular-nums ${done ? 'text-ok' : ''}`}>
                        {n}/{i.quantity}
                      </span>
                      {started && !closed && (
                        <div className="flex gap-1">
                          <button
                            className="btn-ghost btn-sm h-9 w-9"
                            aria-label={`Quitar una unidad de ${i.sku}`}
                            disabled={n === 0}
                            onClick={() => setPicked((p) => adjustPick(d.items, sanitizePicked(d.items, p), i.orderItemId, -1))}
                          >
                            −
                          </button>
                          <button
                            className="btn-ghost btn-sm h-9 w-9"
                            aria-label={`Sumar una unidad de ${i.sku}`}
                            disabled={done}
                            onClick={() => setPicked((p) => adjustPick(d.items, sanitizePicked(d.items, p), i.orderItemId, +1))}
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            {completeErrors.length > 0 && (
              <div className="mt-4 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">
                {completeErrors.map((e, k) => (
                  <p key={k}>{e}</p>
                ))}
              </div>
            )}

            {started && !closed && (
              <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel/95 px-4 py-3 backdrop-blur">
                <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
                  <span className="text-sm text-ink-soft">
                    {progress.complete ? 'Todo recogido' : `Faltan ${progress.total - progress.done} unidad(es)`}
                  </span>
                  <button className="btn-accent" disabled={!progress.complete || complete.isPending} onClick={() => setConfirming(true)}>
                    Completar
                  </button>
                </div>
              </div>
            )}

            <Modal
              open={confirming}
              onClose={() => setConfirming(false)}
              title="Completar picking"
              footer={
                <>
                  <button className="btn-ghost" onClick={() => setConfirming(false)}>
                    Volver
                  </button>
                  <button className="btn-accent" disabled={complete.isPending} onClick={() => complete.mutate(completeBody(d.items, current))}>
                    {complete.isPending ? 'Completando…' : 'Confirmar'}
                  </button>
                </>
              }
            >
              <p className="text-sm">
                Se recogieron las {progress.total} unidades. El pedido quedará listo para{' '}
                {d.fulfillmentType === 'pickup' ? 'retiro en tienda' : 'que lo recoja el transportista'}.
              </p>
            </Modal>
          </div>
        );
      }}
    </QueryState>
  );
}
