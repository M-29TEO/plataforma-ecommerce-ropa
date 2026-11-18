'use client';

import Papa from 'papaparse';
import { useEffect, useMemo, useState } from 'react';
import { formatInt } from '@/lib/format';
import { type ColumnMapping, detectColumns, extractCredits, locateHeaderRow, type StatementLine } from '@/lib/reconciliation';

interface Parsed {
  fileName: string;
  headers: string[];
  rows: Record<string, string>[];
}

/** Lee el archivo como UTF-8; si trae caracteres inválidos, como Windows-1252 (exportes de Excel). */
async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
}

function toRecords(table: string[][]): Omit<Parsed, 'fileName'> {
  const h = locateHeaderRow(table);
  const seen = new Map<string, number>();
  const headers = (table[h] ?? []).map((raw, i) => {
    const base = String(raw ?? '').trim() || `Columna ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
  const rows = table.slice(h + 1).map((r) => Object.fromEntries(headers.map((k, i) => [k, String(r[i] ?? '')])));
  return { headers, rows };
}

/**
 * Importa el extracto bancario en CSV EN EL NAVEGADOR (papaparse): el archivo no se sube.
 * Detecta las columnas por sus nombres habituales y deja corregir el mapeo; entrega solo créditos.
 */
export function StatementImport({ onLines }: { onLines: (lines: StatementLine[] | null) => void }) {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const lines = useMemo(() => (parsed && mapping ? extractCredits(parsed.rows, mapping) : null), [parsed, mapping]);
  useEffect(() => {
    onLines(lines && mapping?.amount ? lines : null);
  }, [lines, mapping, onLines]);

  const load = async (file: File | undefined) => {
    setError('');
    if (!file) return;
    setLoading(true);
    try {
      const text = await readText(file);
      const result = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
      if (result.data.length < 2) throw new Error('El archivo no tiene filas.');
      const { headers, rows } = toRecords(result.data);
      const detected = detectColumns(headers);
      setParsed({ fileName: file.name, headers, rows });
      setMapping(detected);
      if (!detected.amount || !detected.date) setError('No se reconocieron todas las columnas: elige abajo cuál es la fecha y cuál el monto.');
    } catch (e) {
      setParsed(null);
      setMapping(null);
      setError(e instanceof Error ? `No se pudo leer el CSV: ${e.message}` : 'No se pudo leer el CSV.');
    } finally {
      setLoading(false);
    }
  };

  const clear = () => {
    setParsed(null);
    setMapping(null);
    setError('');
  };

  const set = (patch: Partial<ColumnMapping>) => setMapping((m) => (m ? { ...m, ...patch } : m));
  const columnSelect = (id: string, label: string, value: string | null, onChange: (v: string | null) => void, optional = true) => (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select id={id} className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{optional ? '(ninguna)' : '— Elige —'}</option>
        {parsed!.headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <section className="card p-4" aria-label="Extracto bancario">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Extracto bancario (CSV)</h2>
          <p className="text-xs text-ink-soft">Se procesa en tu navegador: el archivo no se sube a ningún servidor.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="btn-ghost btn-sm cursor-pointer">
            {loading ? 'Leyendo…' : parsed ? 'Cambiar archivo' : 'Importar CSV'}
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              onChange={(e) => {
                void load(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {parsed && (
            <button className="btn-ghost btn-sm" onClick={clear}>
              Quitar
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="mt-2 text-sm text-warn" role="alert">
          {error}
        </p>
      )}
      {parsed && mapping && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-ink-soft">
            {parsed.fileName}: {formatInt(parsed.rows.length)} fila(s), {formatInt(lines?.length ?? 0)} crédito(s).
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {columnSelect('map-date', 'Fecha', mapping.date, (v) => set({ date: v }), false)}
            {columnSelect('map-amount', 'Monto o crédito', mapping.amount, (v) => set({ amount: v }), false)}
            {columnSelect('map-debit', 'Débito (se descartan)', mapping.debit, (v) => set({ debit: v }))}
            {columnSelect('map-type', 'Tipo C/D', mapping.type, (v) => set({ type: v }))}
          </div>
          <fieldset>
            <legend className="label">Referencia / descripción (se busca la referencia aquí)</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {parsed.headers.map((h) => (
                <label key={h} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={mapping.description.includes(h)}
                    onChange={(e) => set({ description: e.target.checked ? [...mapping.description, h] : mapping.description.filter((x) => x !== h) })}
                  />
                  {h}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}
    </section>
  );
}
