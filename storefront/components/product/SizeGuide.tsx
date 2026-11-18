'use client';

import { useState } from 'react';
import type { SizeChartData } from '@/lib/types';

export function SizeChartTable({ data }: { data: SizeChartData }) {
  if (!data.columns || !data.rows) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="mb-2 text-left text-xs text-ink-soft">Medidas del cuerpo en {data.unit ?? 'cm'}</caption>
        <thead>
          <tr className="border-b border-line">
            {data.columns.map((c) => (
              <th key={c} scope="col" className="px-2 py-2 text-left font-semibold">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row[0]} className="border-b border-line/60">
              {row.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="px-2 py-2 text-left font-semibold">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className="px-2 py-2">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Guía de tallas del producto (catalog.size_charts) con cómo medirse y el consejo de las reseñas. */
export function SizeGuide({ chart, advice }: { chart: { name: string; data: SizeChartData }; advice: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="text-sm underline" onClick={() => setOpen(true)}>
        Guía de tallas
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center" onClick={() => setOpen(false)} role="presentation">
          <div role="dialog" aria-modal="true" aria-labelledby="size-guide-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-paper p-6 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <h2 id="size-guide-title" className="text-xl">
                {chart.name}
              </h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Cerrar guía de tallas" className="text-xl">
                ✕
              </button>
            </div>
            {advice && <p className="mt-3 rounded-lg bg-sand px-3 py-2 text-sm">{advice}</p>}
            <div className="mt-4">
              <SizeChartTable data={chart.data} />
            </div>
            {chart.data.howToMeasure && chart.data.howToMeasure.length > 0 && (
              <div className="mt-5">
                <h3 className="font-sans text-sm font-semibold">Cómo medirte</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                  {chart.data.howToMeasure.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-5 text-xs text-ink-soft">Si estás entre dos tallas, elige la mayor para un calce más holgado.</p>
          </div>
        </div>
      )}
    </>
  );
}
