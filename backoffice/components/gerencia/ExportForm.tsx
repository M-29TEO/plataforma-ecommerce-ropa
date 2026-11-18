'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useCan } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/providers/ToastProvider';
import { api, errorMessage } from '@/lib/api/client';
import { isoDateInStore } from '@/lib/format';
import {
  DEFAULT_GROUP_BY,
  EXPORT_FORMAT_LABELS,
  EXPORT_FORMATS,
  exportableReports,
  GROUP_BY,
  GROUP_LABELS,
  presetRange,
  RANGE_PRESETS,
  rangeError,
  REPORT_TITLES,
  type CreateExportInput,
  type ExportFormat,
  type ExportJob,
  type RangePreset,
  type ReportKind,
} from '@/lib/reports';

/** Pide un exporte (202): el worker lo genera en segundo plano y aparece en el listado. */
export function ExportForm() {
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const id = useId();
  const reports = exportableReports(can);
  const [report, setReport] = useState<ReportKind>(reports[0] ?? 'sales');
  const [groupBy, setGroupBy] = useState(DEFAULT_GROUP_BY[reports[0] ?? 'sales']);
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [range, setRange] = useState(() => presetRange('30d'));
  const [error, setError] = useState('');
  const invalid = rangeError(range);
  const today = isoDateInStore();

  const create = useMutation({
    mutationFn: (input: CreateExportInput) => api<ExportJob>('/reports/exports', { method: 'POST', body: input }),
    onSuccess: () => {
      toast.ok('Exporte solicitado: aparecerá como listo en unos segundos');
      setError('');
      void qc.invalidateQueries({ queryKey: ['reports', 'exports'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (reports.length === 0) {
    return <p className="text-sm text-ink-soft">Tu rol no puede leer ningún reporte, así que no puede exportarlos.</p>;
  }

  return (
    <form
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        create.mutate({ report, format, groupBy, from: range.from, to: range.to });
      }}
    >
      <div>
        <label className="label" htmlFor={`${id}-report`}>
          Reporte
        </label>
        <select
          id={`${id}-report`}
          className="input"
          value={report}
          required
          onChange={(e) => {
            const r = e.target.value as ReportKind;
            setReport(r);
            setGroupBy(DEFAULT_GROUP_BY[r]);
          }}
        >
          {reports.map((r) => (
            <option key={r} value={r}>
              {REPORT_TITLES[r]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor={`${id}-group`}>
          Agrupar por
        </label>
        <select id={`${id}-group`} className="input" value={groupBy} required onChange={(e) => setGroupBy(e.target.value)}>
          {GROUP_BY[report].map((g) => (
            <option key={g} value={g}>
              {GROUP_LABELS[g] ?? g}
            </option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend className="label">Formato</legend>
        <div className="flex gap-4 pt-2 text-sm">
          {EXPORT_FORMATS.map((f) => (
            <label key={f} className="inline-flex items-center gap-1.5">
              <input type="radio" name={`${id}-format`} value={f} checked={format === f} onChange={() => setFormat(f)} />
              {EXPORT_FORMAT_LABELS[f]}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label className="label" htmlFor={`${id}-preset`}>
          Atajo
        </label>
        <select
          id={`${id}-preset`}
          className="input"
          value={preset}
          onChange={(e) => {
            const p = e.target.value as RangePreset;
            setPreset(p);
            if (p !== 'custom') setRange(presetRange(p));
          }}
        >
          {RANGE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor={`${id}-from`}>
          Desde
        </label>
        <input id={`${id}-from`} type="date" className="input" required max={today} value={range.from} onChange={(e) => {
            setPreset('custom');
            setRange({ ...range, from: e.target.value });
          }} />
      </div>
      <div>
        <label className="label" htmlFor={`${id}-to`}>
          Hasta
        </label>
        <input id={`${id}-to`} type="date" className="input" required max={today} value={range.to} onChange={(e) => {
            setPreset('custom');
            setRange({ ...range, to: e.target.value });
          }} />
      </div>
      <div className="flex items-end sm:col-span-2">
        <button type="submit" className="btn-primary" disabled={create.isPending || Boolean(invalid)}>
          {create.isPending ? 'Solicitando…' : 'Solicitar exporte'}
        </button>
      </div>
      {(invalid || error) && (
        <p className="text-sm text-danger sm:col-span-2 lg:col-span-4" role="alert">
          {invalid ?? error}
        </p>
      )}
    </form>
  );
}
