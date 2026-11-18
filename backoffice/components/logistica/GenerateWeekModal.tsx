'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '@/components/providers/ToastProvider';
import { Modal } from '@/components/ui/Modal';
import { api, errorMessage } from '@/lib/api/client';
import { formatInt, isoDateInStore } from '@/lib/format';
import { formatWeek, type GenerateResult, recentWeeks } from '@/lib/logistics';

/**
 * "Generar semana": arma (o recalcula) los borradores de liquidación de una semana cerrada.
 * Idempotente en el backend; muestra el resultado con los topes de efectivo superados y los fallos.
 */
export function GenerateWeekModal({ open, onClose, nameOf }: { open: boolean; onClose: () => void; nameOf: (riderId: string) => string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const weeks = recentWeeks(isoDateInStore(), 8);
  const [week, setWeek] = useState(weeks[0]);
  const [rebuildDisputed, setRebuildDisputed] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);

  const generate = useMutation({
    mutationFn: () => api<GenerateResult>('/logistics/settlements/generate', { method: 'POST', body: { periodStart: week, rebuildDisputed } }),
    onSuccess: (r) => {
      setResult(r);
      toast.ok('Liquidaciones generadas.');
      void qc.invalidateQueries({ queryKey: ['logistics', 'settlements'] });
    },
  });

  const close = () => {
    setResult(null);
    generate.reset();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Generar liquidaciones de la semana"
      footer={
        result ? (
          <button className="btn-primary" onClick={close}>
            Listo
          </button>
        ) : (
          <>
            <button className="btn-ghost" onClick={close} disabled={generate.isPending}>
              Cancelar
            </button>
            <button className="btn-primary" onClick={() => generate.mutate()} disabled={generate.isPending}>
              {generate.isPending ? 'Generando…' : 'Generar'}
            </button>
          </>
        )
      }
    >
      {!result ? (
        <div className="space-y-3 text-sm">
          <p className="text-ink-soft">
            Calcula los borradores con las entregas de la semana (lunes a domingo). Los borradores existentes se recalculan; las liquidaciones aprobadas o pagadas no se tocan.
          </p>
          <div>
            <label htmlFor="gen-week" className="label">
              Semana
            </label>
            <select id="gen-week" className="input" value={week} onChange={(e) => setWeek(e.target.value)}>
              {weeks.map((w) => (
                <option key={w} value={w}>
                  {formatWeek(w)}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={rebuildDisputed} onChange={(e) => setRebuildDisputed(e.target.checked)} />
            Recalcular también las que están en disputa
          </label>
          {generate.error && (
            <p className="rounded-md bg-danger/10 px-3 py-2 text-danger" role="alert">
              {errorMessage(generate.error)}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p>
            Semana <strong>{formatWeek(result.period.start, result.period.end)}</strong>
          </p>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ['Creadas', result.created],
                ['Recalculadas', result.updated],
                ['Eliminadas', result.removed],
                ['Sin tocar', result.skipped],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="rounded-md border border-line px-3 py-2">
                <dt className="text-xs text-ink-soft">{label}</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatInt(n)}</dd>
              </div>
            ))}
          </dl>
          {result.codLimitExceeded.length > 0 && (
            <div className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2">
              <p className="font-medium text-warn">⚠ Superaron el tope de efectivo ({result.codLimitExceeded.length})</p>
              <ul className="mt-1 list-disc pl-5">
                {result.codLimitExceeded.map((id) => (
                  <li key={id}>{nameOf(id)}</li>
                ))}
              </ul>
            </div>
          )}
          {result.failed.length > 0 && (
            <div className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2" role="alert">
              <p className="font-medium text-danger">✕ No se pudieron liquidar ({result.failed.length})</p>
              <ul className="mt-1 list-disc pl-5">
                {result.failed.map((f) => (
                  <li key={f.riderId}>
                    {nameOf(f.riderId)}: {f.message} <span className="font-mono text-xs text-ink-soft">({f.code})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.codLimitExceeded.length === 0 && result.failed.length === 0 && <p className="text-ok">✓ Sin alertas ni fallos.</p>}
        </div>
      )}
    </Modal>
  );
}
