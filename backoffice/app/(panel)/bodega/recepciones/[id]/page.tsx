'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useSuppliers, useWarehouseName, VariantName } from '@/components/bodega/shared';
import { useCan } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/providers/ToastProvider';
import { BarcodeScanner } from '@/components/scanner/BarcodeScanner';
import { lookupByBarcode, useResolveVariants } from '@/components/scanner/variant-cache';
import { StatusBadge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryState } from '@/components/ui/States';
import { api, errorMessage } from '@/lib/api/client';
import { formatDate, formatDateTime, formatInt, formatMoney } from '@/lib/format';
import {
  canCancel,
  canReceive,
  canSend,
  fillPending,
  PO_STATUS,
  pendingOf,
  poProgress,
  type PurchaseOrder,
  receiptLines,
  registerScan,
  setLineQty,
} from '@/lib/inventory';
import { variantLabel } from '@/lib/scanner';

type Alert = { tone: 'danger' | 'warn' | 'ok'; text: string };

const storageKey = (id: string) => `bo.receipt.${id}`;

function loadCounts(id: string): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(storageKey(id));
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveCounts(id: string, counts: Record<string, number>): void {
  try {
    if (Object.values(counts).some((n) => n > 0)) sessionStorage.setItem(storageKey(id), JSON.stringify(counts));
    else sessionStorage.removeItem(storageKey(id));
  } catch {
    // Sin almacenamiento: el avance vive solo en memoria.
  }
}

/**
 * Recepción de una orden de compra: escanear cada prenda suma 1 a su línea (o se teclea la
 * cantidad), se ve pedido / recibido / pendiente y se confirma con POST :id/receipts. El avance
 * se guarda en sessionStorage para no perderlo si el móvil recarga la página.
 */
export default function ReceptionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const suppliers = useSuppliers();
  const warehouseName = useWarehouseName();

  const [counts, setCounts] = useState<Record<string, number>>(() => (typeof window === 'undefined' ? {} : loadCounts(id)));
  const [alert, setAlert] = useState<Alert | null>(null);
  const [outside, setOutside] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<null | 'receive' | 'send' | 'cancel'>(null);
  const [busyScan, setBusyScan] = useState(false);

  const q = useQuery({
    queryKey: ['inventory', 'purchase-orders', id],
    queryFn: ({ signal }) => api<PurchaseOrder>(`/inventory/purchase-orders/${id}`, { signal }),
  });
  const po = q.data;
  useResolveVariants(po?.items.map((i) => i.variantId) ?? []);

  // Las lecturas llegan más rápido que los renders: el conteo vigente se lee de un ref.
  const countsRef = useRef(counts);
  useEffect(() => {
    countsRef.current = counts;
    saveCounts(id, counts);
  }, [id, counts]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['inventory', 'purchase-orders'] });

  const receive = useMutation({
    mutationFn: (body: { lines: { itemId: string; quantity: number }[]; note?: string }) =>
      api<PurchaseOrder>(`/inventory/purchase-orders/${id}/receipts`, { method: 'POST', body }),
    onSuccess: (updated) => {
      qc.setQueryData(['inventory', 'purchase-orders', id], updated);
      void invalidate();
      void qc.invalidateQueries({ queryKey: ['inventory', 'stock'] });
      setCounts({});
      setOutside([]);
      setNote('');
      setConfirm(null);
      toast.ok(updated.status === 'received' ? 'Orden recibida por completo' : 'Recepción parcial registrada');
    },
    onError: (e) => toast.error(e),
  });

  const transition = useMutation({
    mutationFn: (action: 'send' | 'cancel') => api<PurchaseOrder>(`/inventory/purchase-orders/${id}/${action}`, { method: 'POST' }),
    onSuccess: (updated, action) => {
      qc.setQueryData(['inventory', 'purchase-orders', id], updated);
      void invalidate();
      setConfirm(null);
      toast.ok(action === 'send' ? 'Orden marcada como enviada' : 'Orden cancelada');
    },
    onError: (e) => toast.error(e),
  });

  function vibrate(pattern: number | number[]) {
    try {
      navigator.vibrate?.(pattern);
    } catch {
      // Sin vibración.
    }
  }

  async function onScan(code: string) {
    if (!po) return;
    setBusyScan(true);
    try {
      const v = await lookupByBarcode(code);
      if (!v) {
        vibrate([200, 80, 200]);
        setAlert({ tone: 'danger', text: `El código ${code} no corresponde a ninguna prenda del catálogo.` });
        return;
      }
      const result = registerScan(po.items, countsRef.current, v.variantId);
      if (result.kind === 'not_in_order') {
        vibrate([200, 80, 200]);
        setOutside((o) => [code, ...o.filter((c) => c !== code)].slice(0, 20));
        setAlert({ tone: 'danger', text: `${variantLabel(v)} (${v.sku}) NO está en esta orden de compra. Sepárala.` });
      } else if (result.kind === 'complete') {
        vibrate([150, 60, 150]);
        setAlert({ tone: 'warn', text: `Ya completaste lo pendiente de ${variantLabel(v)}: esta unidad sobra.` });
      } else {
        countsRef.current = result.counts;
        setCounts(result.counts);
        const item = po.items.find((i) => i.id === result.itemId)!;
        setAlert({ tone: 'ok', text: `+1 ${variantLabel(v)} (${result.counts[result.itemId]} de ${pendingOf(item)} pendientes)` });
      }
    } catch (e) {
      setAlert({ tone: 'danger', text: errorMessage(e) });
    } finally {
      setBusyScan(false);
    }
  }

  return (
    <QueryState query={q}>
      {() => {
        if (!po) return null;
        const p = poProgress(po.items, counts);
        const lines = receiptLines(po.items, counts);
        const receivable = canReceive(po.status) && can('inventory.purchase.receive');
        const writer = can('inventory.purchase.write');
        return (
          <div>
            <PageHeader
              title={`Orden ${po.number}`}
              back={{ href: '/bodega/recepciones', label: 'Recepción de compras' }}
              description={
                <>
                  {suppliers.data?.find((s) => s.id === po.supplierId)?.name ?? 'Proveedor'} · {warehouseName(po.warehouseId)} · creada{' '}
                  {formatDateTime(po.createdAt)}
                  {po.expectedAt && <> · esperada {formatDate(`${po.expectedAt}T12:00:00Z`)}</>}
                </>
              }
              actions={
                <>
                  <StatusBadge status={po.status} map={PO_STATUS} />
                  {writer && canSend(po.status) && (
                    <button className="btn-primary btn-sm" onClick={() => setConfirm('send')}>
                      Marcar enviada
                    </button>
                  )}
                  {writer && canCancel(po.status) && (
                    <button className="btn-ghost btn-sm text-danger" onClick={() => setConfirm('cancel')}>
                      Cancelar orden
                    </button>
                  )}
                </>
              }
            />

            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Pedido', p.ordered],
                ['Recibido antes', p.received],
                ['Pendiente', p.pending],
                ['En esta recepción', p.now],
              ].map(([k, v]) => (
                <div key={k} className="card px-4 py-3">
                  <p className="text-xs text-ink-soft">{k}</p>
                  <p className="text-xl font-semibold tabular-nums">{formatInt(v)}</p>
                </div>
              ))}
            </div>

            {receivable && (
              <section className="card mb-4 space-y-3 p-4">
                <BarcodeScanner onDetected={(c) => void onScan(c)} busy={busyScan} label="Escanea cada prenda recibida" />
                {alert && (
                  <p
                    role="alert"
                    className={`rounded-md px-3 py-2 text-sm font-medium ${
                      alert.tone === 'danger' ? 'bg-danger text-white' : alert.tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-ok/10 text-ok'
                    }`}
                  >
                    {alert.text}
                  </p>
                )}
                {outside.length > 0 && (
                  <p className="text-xs text-danger">
                    Códigos leídos que no son de esta orden: <span className="font-mono">{outside.join(', ')}</span>
                  </p>
                )}
              </section>
            )}
            {!receivable && canReceive(po.status) && (
              <p className="mb-4 text-sm text-ink-soft">Tu rol no puede registrar recepciones.</p>
            )}
            {po.status === 'draft' && (
              <p className="mb-4 rounded-md border border-line bg-sand/50 px-3 py-2 text-sm">
                La orden está en borrador: márcala como enviada al proveedor para poder recibirla.
              </p>
            )}

            <div className="card overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Variante</th>
                    <th className="num">Pedido</th>
                    <th className="num">Recibido</th>
                    <th className="num">Pendiente</th>
                    {receivable && <th className="num">Recibir ahora</th>}
                    <th className="num">Costo</th>
                  </tr>
                </thead>
                <tbody>
                  {po.items.map((item) => {
                    const pending = pendingOf(item);
                    const now = counts[item.id] ?? 0;
                    const done = pending > 0 && now === pending;
                    return (
                      <tr key={item.id} className={done ? 'bg-ok/5' : undefined}>
                        <td className="max-w-64">
                          <VariantName variantId={item.variantId} />
                        </td>
                        <td className="num">{formatInt(item.qtyOrdered)}</td>
                        <td className="num">{formatInt(item.qtyReceived)}</td>
                        <td className={`num ${pending - now > 0 ? 'font-medium text-warn' : 'text-ok'}`}>{formatInt(pending - now)}</td>
                        {receivable && (
                          <td className="num">
                            {pending === 0 ? (
                              <span className="text-xs text-ok">Completo</span>
                            ) : (
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  className="btn-ghost btn-sm"
                                  aria-label="Restar uno"
                                  disabled={now === 0}
                                  onClick={() => setCounts((c) => setLineQty(po.items, c, item.id, now - 1))}
                                >
                                  −
                                </button>
                                <input
                                  aria-label="Cantidad a recibir"
                                  className="input w-16 px-1 text-center"
                                  type="number"
                                  inputMode="numeric"
                                  min={0}
                                  max={pending}
                                  value={now}
                                  onChange={(e) => setCounts((c) => setLineQty(po.items, c, item.id, Number(e.target.value)))}
                                />
                                <button
                                  type="button"
                                  className="btn-ghost btn-sm"
                                  aria-label="Sumar uno"
                                  disabled={now >= pending}
                                  onClick={() => setCounts((c) => setLineQty(po.items, c, item.id, now + 1))}
                                >
                                  +
                                </button>
                              </div>
                            )}
                          </td>
                        )}
                        <td className="num">{formatMoney(item.unitCost)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {receivable && (
              <div className="mt-4 space-y-3">
                <div>
                  <label htmlFor="receipt-note" className="label">
                    Nota (opcional: guía del proveedor, novedades)
                  </label>
                  <textarea id="receipt-note" className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <button className="btn-ghost" onClick={() => setCounts(fillPending(po.items))} disabled={p.pending === 0}>
                    Recibir todo lo pendiente
                  </button>
                  <button className="btn-ghost" onClick={() => setCounts({})} disabled={p.now === 0}>
                    Limpiar
                  </button>
                  <button className="btn-accent" onClick={() => setConfirm('receive')} disabled={lines.length === 0}>
                    Confirmar recepción ({formatInt(p.now)})
                  </button>
                </div>
              </div>
            )}

            <Modal
              open={confirm === 'receive'}
              onClose={() => setConfirm(null)}
              title="Confirmar recepción"
              footer={
                <>
                  <button className="btn-ghost" onClick={() => setConfirm(null)}>
                    Volver
                  </button>
                  <button
                    className="btn-accent"
                    disabled={receive.isPending}
                    onClick={() => receive.mutate({ lines, note: note.trim() || undefined })}
                  >
                    {receive.isPending ? 'Registrando…' : 'Registrar'}
                  </button>
                </>
              }
            >
              <p className="text-sm">
                Se sumarán <strong>{formatInt(p.now)}</strong> unidad(es) en {lines.length} línea(s) al stock de {warehouseName(po.warehouseId)}.
                {p.remainingAfter > 0
                  ? ` Quedarán ${formatInt(p.remainingAfter)} pendientes (recepción parcial).`
                  : ' La orden quedará recibida por completo.'}
              </p>
              <p className="mt-2 text-xs text-ink-soft">Lo recibido entra al registro de movimientos y no se puede deshacer desde aquí.</p>
            </Modal>

            <Modal
              open={confirm === 'send' || confirm === 'cancel'}
              onClose={() => setConfirm(null)}
              title={confirm === 'send' ? 'Marcar como enviada' : 'Cancelar orden de compra'}
              footer={
                <>
                  <button className="btn-ghost" onClick={() => setConfirm(null)}>
                    Volver
                  </button>
                  <button
                    className={confirm === 'cancel' ? 'btn-danger' : 'btn-primary'}
                    disabled={transition.isPending}
                    onClick={() => confirm && confirm !== 'receive' && transition.mutate(confirm)}
                  >
                    {transition.isPending ? 'Guardando…' : confirm === 'send' ? 'Marcar enviada' : 'Cancelar orden'}
                  </button>
                </>
              }
            >
              <p className="text-sm">
                {confirm === 'send'
                  ? 'La orden quedará lista para recibirse en bodega. Ya no se podrá editar.'
                  : 'La orden se cancelará y no podrá recibirse. Esta acción no se puede deshacer.'}
              </p>
            </Modal>
          </div>
        );
      }}
    </QueryState>
  );
}
