'use client';

import { useId, useState } from 'react';
import { useWarehouses } from '@/components/bodega/shared';
import { useAuth, useCan } from '@/components/providers/AuthProvider';
import { Modal } from '@/components/ui/Modal';
import { errorMessage } from '@/lib/api/client';
import { warehouseLabel } from '@/lib/inventory';
import {
  buildInspectBody,
  CONDITION_LABEL,
  initialInspection,
  type InspectionDraft,
  type InspectionResult,
  ITEM_CONDITIONS,
  type ItemCondition,
  REJECT_REASON_MIN,
  RETURN_STATUS,
  returnActions,
  type ReturnDetail,
  withCondition,
} from '@/lib/returns';
import { useReturnAction } from './useReturnAction';

type Kind = 'approve' | 'reject' | 'receive' | 'inspect' | 'retryExchange';

const LABEL: Record<Kind, string> = {
  approve: 'Aprobar',
  reject: 'Rechazar',
  receive: 'Recibir en bodega',
  inspect: 'Inspeccionar',
  retryExchange: 'Reintentar envío del cambio',
};

/**
 * Botones de la devolución: SOLO las acciones válidas para su estado que el usuario puede hacer
 * (lib/returns.ts). Cada una se confirma en un diálogo que muestra el error del API si falla.
 */
export function ReturnActionsBar({ ret }: { ret: ReturnDetail }) {
  const { permissions } = useAuth();
  const [open, setOpen] = useState<Kind | null>(null);
  const actions = returnActions(ret, permissions);
  const kinds = (Object.keys(LABEL) as Kind[]).filter((k) => actions[k]);
  if (kinds.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {kinds.map((k) => (
          <button key={k} className={k === 'reject' ? 'btn-danger btn-sm' : 'btn-primary btn-sm'} onClick={() => setOpen(k)}>
            {LABEL[k]}
          </button>
        ))}
      </div>
      {/* Cada diálogo se monta al abrirse: parte de un formulario limpio. */}
      {open === 'approve' && <ApproveDialog ret={ret} onClose={() => setOpen(null)} />}
      {open === 'reject' && <RejectDialog ret={ret} onClose={() => setOpen(null)} />}
      {open === 'receive' && <ReceiveDialog ret={ret} onClose={() => setOpen(null)} />}
      {open === 'inspect' && <InspectDialog ret={ret} onClose={() => setOpen(null)} />}
      {open === 'retryExchange' && <RetryExchangeDialog ret={ret} onClose={() => setOpen(null)} />}
    </>
  );
}

function Footer({ busy, onClose, onConfirm, label, danger = false, disabled = false }: { busy: boolean; onClose: () => void; onConfirm: () => void; label: string; danger?: boolean; disabled?: boolean }) {
  return (
    <>
      <button className="btn-ghost" onClick={onClose} disabled={busy}>
        Volver
      </button>
      <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={busy || disabled}>
        {busy ? 'Guardando…' : label}
      </button>
    </>
  );
}

function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="text-sm text-danger" role="alert">
      {errorMessage(error)}
    </p>
  );
}

function ApproveDialog({ ret, onClose }: { ret: ReturnDetail; onClose: () => void }) {
  const m = useReturnAction<void>(ret.id, () => ({ path: '/approve' }), { ok: (r) => `Devolución ${r.rmaNumber}: ${RETURN_STATUS[r.status][0].toLowerCase()}` });
  return (
    <Modal open onClose={onClose} title={`Aprobar ${ret.rmaNumber}`} size="sm" footer={<Footer busy={m.isPending} onClose={onClose} onConfirm={() => m.mutate(undefined, { onSuccess: onClose })} label="Aprobar" />}>
      <div className="space-y-2 text-sm">
        <p>Se aprueba la {ret.type === 'exchange' ? 'solicitud de cambio' : 'devolución'} y Logística programa el retiro del paquete en la dirección del pedido.</p>
        {ret.type === 'exchange' && <p className="text-ink-soft">En un cambio se verifica que haya stock de la talla nueva.</p>}
        <ErrorText error={m.error} />
      </div>
    </Modal>
  );
}

function RejectDialog({ ret, onClose }: { ret: ReturnDetail; onClose: () => void }) {
  const id = useId();
  const [reason, setReason] = useState('');
  const m = useReturnAction<string>(ret.id, (r) => ({ path: '/reject', body: { reason: r } }), { ok: (r) => `Devolución ${r.rmaNumber} rechazada` });
  const ok = reason.trim().length >= REJECT_REASON_MIN;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Rechazar ${ret.rmaNumber}`}
      size="sm"
      footer={<Footer busy={m.isPending} danger disabled={!ok} onClose={onClose} onConfirm={() => m.mutate(reason.trim(), { onSuccess: onClose })} label="Rechazar" />}
    >
      <div className="space-y-3 text-sm">
        <p>{ret.status === 'received' ? 'La inspección no acepta el paquete recibido.' : 'La solicitud no procede.'} El rechazo no se puede deshacer.</p>
        <div>
          <label htmlFor={id} className="label">
            Motivo (obligatorio, lo verá el cliente)
          </label>
          <textarea id={id} className="input" rows={3} minLength={REJECT_REASON_MIN} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <ErrorText error={m.error} />
      </div>
    </Modal>
  );
}

function ReceiveDialog({ ret, onClose }: { ret: ReturnDetail; onClose: () => void }) {
  const can = useCan();
  // La lista de bodegas es de Inventario: sin inventory.read se usa la bodega prevista en el retiro.
  const showSelect = can('inventory.read');
  const [warehouseId, setWarehouseId] = useState('');
  const m = useReturnAction<string>(ret.id, (w) => ({ path: '/receive', body: w ? { warehouseId: w } : {} }), { ok: (r) => `Devolución ${r.rmaNumber} recibida` });
  return (
    <Modal open onClose={onClose} title={`Recibir ${ret.rmaNumber}`} size="sm" footer={<Footer busy={m.isPending} onClose={onClose} onConfirm={() => m.mutate(warehouseId, { onSuccess: onClose })} label="Confirmar recepción" />}>
      <div className="space-y-3 text-sm">
        <p>El paquete llegó a bodega: la devolución y su envío de retiro quedan como recibidos. Después se inspecciona cada prenda.</p>
        {showSelect && <ReceivingWarehouse value={warehouseId} onChange={setWarehouseId} />}
        <ErrorText error={m.error} />
      </div>
    </Modal>
  );
}

function ReceivingWarehouse({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const id = useId();
  const warehouses = useWarehouses();
  return (
    <div>
      <label htmlFor={id} className="label">
        Bodega que lo recibió
      </label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={warehouses.isPending}>
        <option value="">La prevista en el retiro</option>
        {warehouses.data?.map((w) => (
          <option key={w.id} value={w.id}>
            {warehouseLabel(w)}
          </option>
        ))}
      </select>
    </div>
  );
}

function InspectDialog({ ret, onClose }: { ret: ReturnDetail; onClose: () => void }) {
  const [draft, setDraft] = useState<Record<string, InspectionDraft>>(() => initialInspection(ret.lines));
  const m = useReturnAction<void, InspectionResult>(ret.id, () => ({ path: '/inspect', body: buildInspectBody(ret.lines, draft) }), {
    pick: (r) => r.return,
    ok: (r) =>
      r.exchangePending
        ? `Inspeccionada. No hay stock de la talla nueva: reintenta el envío del cambio cuando ingrese.`
        : `Devolución ${r.return.rmaNumber}: ${RETURN_STATUS[r.return.status][0].toLowerCase()}`,
  });
  const set = (lineId: string, d: InspectionDraft) => setDraft((all) => ({ ...all, [lineId]: d }));

  return (
    <Modal open onClose={onClose} title={`Inspeccionar ${ret.rmaNumber}`} size="lg" footer={<Footer busy={m.isPending} onClose={onClose} onConfirm={() => m.mutate(undefined, { onSuccess: onClose })} label="Registrar inspección" />}>
      <div className="space-y-3 text-sm">
        <p>
          Indica la condición de cada prenda y si vuelve al stock vendible.{' '}
          {ret.type === 'return'
            ? 'Al registrar se calcula el monto y se solicita el reembolso (queda por aprobar).'
            : 'Al registrar se despacha la talla nueva.'}
        </p>
        <div className="-mx-5 overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Cant.</th>
                <th>Condición</th>
                <th>Reingreso</th>
              </tr>
            </thead>
            <tbody>
              {ret.lines.map((l) => {
                const d = draft[l.returnItemId] ?? { condition: 'new', restock: true };
                return (
                  <tr key={l.returnItemId}>
                    <td className="max-w-60">
                      <span className="block font-medium">{l.productName}</span>
                      <span className="block text-xs text-ink-soft">
                        {[l.colorName, l.sizeCode].filter(Boolean).join(' · ')} · <span className="font-mono">{l.sku}</span>
                      </span>
                    </td>
                    <td className="num">{l.quantity}</td>
                    <td>
                      <select
                        className="input"
                        aria-label={`Condición de ${l.productName}`}
                        value={d.condition}
                        onChange={(e) => set(l.returnItemId, withCondition(d, e.target.value as ItemCondition))}
                      >
                        {ITEM_CONDITIONS.map((c) => (
                          <option key={c} value={c}>
                            {CONDITION_LABEL[c]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <label className="inline-flex items-center gap-2 whitespace-nowrap" title={d.condition === 'damaged' ? 'Una prenda dañada no vuelve al stock vendible' : undefined}>
                        <input
                          type="checkbox"
                          checked={d.condition !== 'damaged' && d.restock}
                          disabled={d.condition === 'damaged'}
                          onChange={(e) => set(l.returnItemId, { ...d, restock: e.target.checked })}
                        />
                        Vuelve al stock
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ErrorText error={m.error} />
      </div>
    </Modal>
  );
}

function RetryExchangeDialog({ ret, onClose }: { ret: ReturnDetail; onClose: () => void }) {
  const m = useReturnAction<void>(ret.id, () => ({ path: '/exchange-shipment' }), { ok: (r) => `Cambio ${r.rmaNumber} despachado` });
  return (
    <Modal open onClose={onClose} title="Reintentar envío del cambio" size="sm" footer={<Footer busy={m.isPending} onClose={onClose} onConfirm={() => m.mutate(undefined, { onSuccess: onClose })} label="Reintentar" />}>
      <div className="space-y-2 text-sm">
        <p>Se vuelve a reservar la talla nueva y a crear su envío. Si sigue sin stock, la devolución queda como está.</p>
        <ErrorText error={m.error} />
      </div>
    </Modal>
  );
}
