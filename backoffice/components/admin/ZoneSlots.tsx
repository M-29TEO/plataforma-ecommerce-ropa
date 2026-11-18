'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { useToast } from '@/components/providers/ToastProvider';
import { EmptyState, QueryState } from '@/components/ui/States';
import {
  addDaysIso,
  type DeliverySlot,
  normalizeMoney,
  shortTime,
  type SlotTemplate,
  type SlotTemplateInput,
  sortTemplates,
  validateSlotTemplate,
  WEEKDAYS,
  type Zone,
  zoneServesRiders,
} from '@/lib/admin';
import { api } from '@/lib/api/client';
import { formatDate, formatMoney, formatTime, isoDateInStore } from '@/lib/format';

const EMPTY: SlotTemplateInput = { weekday: 1, startTime: '09:00', endTime: '13:00', capacity: 10, surcharge: '0.00' };

/**
 * Plantillas semanales de franjas horarias de una zona y generación de las franjas concretas
 * (el job diario las genera solo; el botón adelanta el proceso tras un cambio).
 */
export function ZoneSlots({ zone, canWrite }: { zone: Zone; canWrite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<{ id: string | null; value: SlotTemplateInput } | null>(null);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<SlotTemplate | null>(null);
  const base = `/logistics/zones/${zone.id}`;
  const from = isoDateInStore();
  const to = addDaysIso(from, 6);

  const templates = useQuery({
    queryKey: ['logistics', 'zones', zone.id, 'slot-templates'],
    queryFn: ({ signal }) => api<SlotTemplate[]>(`${base}/slot-templates`, { signal }),
  });
  const slots = useQuery({
    queryKey: ['logistics', 'zones', zone.id, 'slots', from, to],
    queryFn: ({ signal }) => api<DeliverySlot[]>(`${base}/slots`, { query: { from, to }, signal }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['logistics', 'zones', zone.id] });

  const save = useMutation({
    mutationFn: ({ id, value }: { id: string | null; value: SlotTemplateInput }) =>
      id
        ? api<SlotTemplate>(`${base}/slot-templates/${id}`, { method: 'PATCH', body: value })
        : api<SlotTemplate>(`${base}/slot-templates`, { method: 'POST', body: value }),
    onSuccess: (_, v) => {
      toast.ok(v.id ? 'Franja actualizada' : 'Franja creada');
      setEditing(null);
      void invalidate();
    },
    onError: (e) => toast.error(e),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${base}/slot-templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.ok('Franja eliminada');
      setDeleting(null);
      void invalidate();
    },
    onError: (e) => {
      toast.error(e);
      setDeleting(null);
    },
  });
  const generate = useMutation({
    mutationFn: () => api<{ created: number }>(`${base}/slots/generate`, { method: 'POST' }),
    onSuccess: (r) => {
      toast.info(r.created ? `Se generaron ${r.created} franja(s) nuevas` : 'No había franjas nuevas por generar');
      void invalidate();
    },
    onError: (e) => toast.error(e),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const value = { ...editing.value, surcharge: normalizeMoney(editing.value.surcharge) };
    const problem = validateSlotTemplate(value);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    save.mutate({ id: editing.id, value });
  }

  const setField = <K extends keyof SlotTemplateInput>(k: K, v: SlotTemplateInput[K]) => setEditing((p) => (p ? { ...p, value: { ...p.value, [k]: v } } : p));
  const serves = zoneServesRiders(zone);

  return (
    <div className="space-y-4">
      {!serves && (
        <p className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          {zone.active ? 'La zona es solo courier: no usa franjas de motorizado.' : 'La zona está inactiva: no se generan franjas.'}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Plantillas semanales</h3>
        {canWrite && (
          <div className="flex gap-2">
            <button className="btn-ghost btn-sm" onClick={() => generate.mutate()} disabled={generate.isPending || !serves}>
              {generate.isPending ? 'Generando…' : 'Generar franjas'}
            </button>
            <button
              className="btn-primary btn-sm"
              onClick={() => {
                setError('');
                setEditing({ id: null, value: EMPTY });
              }}
            >
              Nueva franja
            </button>
          </div>
        )}
      </div>

      {editing && (
        <form onSubmit={submit} className="rounded-md border border-line bg-sand/40 p-3" noValidate>
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <label className="label" htmlFor="st-day">Día</label>
              <select id="st-day" className="input" value={editing.value.weekday} onChange={(e) => setField('weekday', Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>{d}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="st-start">Desde</label>
              <input id="st-start" type="time" className="input" required value={editing.value.startTime} onChange={(e) => setField('startTime', e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="st-end">Hasta</label>
              <input id="st-end" type="time" className="input" required value={editing.value.endTime} onChange={(e) => setField('endTime', e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="st-cap">Capacidad (pedidos)</label>
              <input
                id="st-cap"
                type="number"
                min={0}
                max={10000}
                step={1}
                className="input"
                value={editing.value.capacity}
                onChange={(e) => setField('capacity', Number(e.target.value))}
              />
            </div>
            <div>
              <label className="label" htmlFor="st-sur">Recargo (USD)</label>
              <input id="st-sur" inputMode="decimal" className="input num" value={editing.value.surcharge} onChange={(e) => setField('surcharge', e.target.value)} />
            </div>
          </div>
          {error && (
            <p className="mt-2 text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(null)} disabled={save.isPending}>
              Cancelar
            </button>
            <button className="btn-primary btn-sm" disabled={save.isPending}>
              {save.isPending ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-soft">Los cambios aplican a las franjas que se generen desde ahora; las ya generadas no cambian.</p>
        </form>
      )}

      <QueryState query={templates} loading="Cargando franjas…">
        {(list) =>
          list.length === 0 ? (
            <EmptyState title="Sin franjas">Crea al menos una para ofrecer entregas programadas en esta zona.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Día</th>
                    <th>Horario</th>
                    <th className="num">Cupo</th>
                    <th className="num">Recargo</th>
                    {canWrite && <th aria-label="Acciones" />}
                  </tr>
                </thead>
                <tbody>
                  {sortTemplates(list).map((t) => (
                    <tr key={t.id}>
                      <td>{WEEKDAYS[t.weekday]}</td>
                      <td className="whitespace-nowrap">
                        {shortTime(t.startTime)}–{shortTime(t.endTime)}
                      </td>
                      <td className="num">{t.capacity}</td>
                      <td className="num">{formatMoney(t.surcharge)}</td>
                      {canWrite && (
                        <td className="whitespace-nowrap text-right">
                          <button
                            className="btn-ghost btn-sm"
                            onClick={() => {
                              setError('');
                              setEditing({
                                id: t.id,
                                value: { weekday: t.weekday, startTime: shortTime(t.startTime), endTime: shortTime(t.endTime), capacity: t.capacity, surcharge: t.surcharge },
                              });
                            }}
                          >
                            Editar
                          </button>{' '}
                          <button className="btn-ghost btn-sm text-danger" onClick={() => setDeleting(t)}>
                            Eliminar
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </QueryState>

      <div>
        <h3 className="text-sm font-semibold">Franjas de los próximos 7 días</h3>
        <QueryState query={slots} loading="Cargando…">
          {(list) =>
            list.length === 0 ? (
              <p className="mt-1 text-xs text-ink-soft">No hay franjas generadas en este rango.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line text-sm">
                {list.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span>
                      {formatDate(`${s.slotDate}T12:00:00Z`)} · {formatTime(s.startsAt)}–{formatTime(s.endsAt)}
                    </span>
                    <span className={`tabular-nums ${s.booked >= s.capacity ? 'text-danger' : 'text-ink-soft'}`}>
                      {s.booked}/{s.capacity}
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryState>
      </div>

      <ConfirmDialog
        open={!!deleting}
        title="Eliminar franja"
        confirmLabel="Eliminar"
        busy={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      >
        {deleting && (
          <p>
            Se eliminará la plantilla de {WEEKDAYS[deleting.weekday]} {shortTime(deleting.startTime)}–{shortTime(deleting.endTime)}. No se generarán
            más franjas con ella; las ya generadas se mantienen.
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
