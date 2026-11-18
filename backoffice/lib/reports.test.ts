import { describe, expect, it } from 'vitest';
import {
  addDays,
  canDownload,
  delta,
  deltaTone,
  deliveryBuckets,
  exportableReports,
  exportFilename,
  formatBytes,
  formatDelta,
  formatMinutes,
  funnelStages,
  hasActiveExports,
  isOpenPeriod,
  pctToRatio,
  periodLabel,
  presetRange,
  previousRange,
  rangeDays,
  rangeError,
  timeGroupFor,
  type DeliveryMetrics,
  type FunnelMetrics,
} from './reports';

// 2026-10-07 02:00 UTC = 2026-10-06 21:00 en Guayaquil (UTC-5).
const NIGHT = new Date('2026-10-07T02:00:00Z');

describe('rangos de fechas', () => {
  it('atajos con "hoy" en la hora de Ecuador', () => {
    expect(presetRange('today', NIGHT)).toEqual({ from: '2026-10-06', to: '2026-10-06' });
    expect(presetRange('7d', NIGHT)).toEqual({ from: '2026-09-30', to: '2026-10-06' });
    expect(presetRange('30d', NIGHT)).toEqual({ from: '2026-09-07', to: '2026-10-06' });
    expect(presetRange('month', NIGHT)).toEqual({ from: '2026-10-01', to: '2026-10-06' });
  });

  it('días incluidos y período anterior del mismo largo (igual que el API)', () => {
    expect(rangeDays({ from: '2026-09-01', to: '2026-09-30' })).toBe(30);
    expect(previousRange({ from: '2026-09-01', to: '2026-09-30' })).toEqual({ from: '2026-08-02', to: '2026-08-31' });
    expect(previousRange({ from: '2026-10-06', to: '2026-10-06' })).toEqual({ from: '2026-10-05', to: '2026-10-05' });
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('valida orden, fechas reales y el tope de 2 años', () => {
    expect(rangeError({ from: '2026-09-01', to: '2026-09-30' })).toBeNull();
    expect(rangeError({ from: '2026-10-01', to: '2026-09-30' })).toMatch(/posterior/);
    expect(rangeError({ from: '2026-02-30', to: '2026-03-01' })).toMatch(/fechas/);
    expect(rangeError({ from: '', to: '2026-03-01' })).toMatch(/fechas/);
    expect(rangeError({ from: '2024-01-02', to: '2026-01-01' })).toBeNull(); // 731 días (2024 es bisiesto)
    expect(rangeError({ from: '2024-01-01', to: '2026-01-01' })).toMatch(/731/);
  });

  it('granularidad del gráfico según el largo', () => {
    expect(timeGroupFor({ from: '2026-09-01', to: '2026-09-30' })).toBe('day');
    expect(timeGroupFor({ from: '2026-01-01', to: '2026-09-30' })).toBe('week');
    expect(timeGroupFor({ from: '2025-01-01', to: '2026-09-30' })).toBe('month');
  });

  it('etiquetas de período sin correr la fecha por la zona horaria', () => {
    expect(periodLabel('2026-10-01', 'day')).toMatch(/01/);
    expect(periodLabel('2026-10-01', 'day')).toMatch(/oct/);
    expect(periodLabel('2026-09-28', 'week')).toMatch(/^sem\. 28/);
    expect(periodLabel('2026-10', 'month')).toMatch(/oct/);
    expect(periodLabel('Quito', 'city')).toBe('Quito');
  });

  it('período abierto (parcial) según el día de Ecuador', () => {
    // NIGHT: en Guayaquil todavía es martes 06-oct, aunque en UTC ya sea 07.
    expect(isOpenPeriod('2026-10-06', 'day', NIGHT)).toBe(true);
    expect(isOpenPeriod('2026-10-07', 'day', NIGHT)).toBe(false);
    expect(isOpenPeriod('2026-10-05', 'day', NIGHT)).toBe(false);
    expect(isOpenPeriod('2026-10-05', 'week', NIGHT)).toBe(true);
    expect(isOpenPeriod('2026-09-28', 'week', NIGHT)).toBe(false);
    expect(isOpenPeriod('2026-10', 'month', NIGHT)).toBe(true);
    expect(isOpenPeriod('2026-09', 'month', NIGHT)).toBe(false);
    expect(isOpenPeriod('Quito', 'city', NIGHT)).toBe(false);
  });
});

describe('KPIs', () => {
  it('variación relativa para montos y en puntos para tasas', () => {
    expect(delta('110.00', '100.00')).toEqual({ value: 0.1, kind: 'relative' });
    expect(delta(5, 0)).toBeNull();
    expect(delta(null, 3)).toBeNull();
    expect(delta(42.5, 40, 'points')).toEqual({ value: 2.5, kind: 'points' });
  });

  it('color según si subir es bueno', () => {
    expect(deltaTone({ value: 0.1, kind: 'relative' })).toBe('ok');
    expect(deltaTone({ value: 0.1, kind: 'relative' }, false)).toBe('danger');
    expect(deltaTone({ value: -2, kind: 'points' }, false)).toBe('ok');
    expect(deltaTone({ value: 0, kind: 'points' })).toBe('neutral');
    expect(deltaTone(null)).toBe('neutral');
  });

  it('textos de variación, porcentajes y minutos', () => {
    expect(formatDelta(null)).toBe('sin comparación');
    expect(formatDelta({ value: 2.5, kind: 'points' })).toMatch(/^\+2,5 pp$/);
    expect(formatDelta({ value: -0.125, kind: 'relative' })).toMatch(/12,5/);
    expect(pctToRatio(12.5)).toBe(0.125);
    expect(pctToRatio(null)).toBeNull();
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(135)).toBe('2 h 15 min');
    expect(formatMinutes(120)).toBe('2 h');
    expect(formatMinutes(3000)).toBe('2 d 2 h');
    expect(formatMinutes(null)).toBe('—');
  });

  it('etapas del embudo con la tasa de paso', () => {
    const f = { cartsCreated: 200, cartsWithItems: 100, ordersPlaced: 40, ordersPaid: 30 } as FunnelMetrics;
    const stages = funnelStages(f);
    expect(stages.map((s) => s.value)).toEqual([200, 100, 40, 30]);
    expect(stages[0].stepRate).toBeNull();
    expect(stages[1].stepRate).toBe(0.5);
    expect(stages[3].stepRate).toBe(0.75);
    expect(funnelStages({ ...f, cartsCreated: 0, cartsWithItems: 0 })[1].stepRate).toBeNull();
  });

  it('tramos de entrega con su participación', () => {
    const d = { within2h: 1, within24h: 2, within48h: 1, over48h: 0 } as DeliveryMetrics;
    expect(deliveryBuckets(d).map((b) => b.share)).toEqual([0.25, 0.5, 0.25, 0]);
    expect(deliveryBuckets({ ...d, within2h: 0, within24h: 0, within48h: 0 }).every((b) => b.share === 0)).toBe(true);
  });
});

describe('exportes', () => {
  const job = { id: 'x', report: 'sales_items' as const, format: 'xlsx' as const, params: { from: '2026-09-01', to: '2026-09-30', groupBy: 'product', limit: 100 }, filename: null };

  it('se refresca solo mientras hay alguno en curso', () => {
    expect(hasActiveExports([{ status: 'done' }, { status: 'running' }])).toBe(true);
    expect(hasActiveExports([{ status: 'queued' }])).toBe(true);
    expect(hasActiveExports([{ status: 'done' }, { status: 'failed' }])).toBe(false);
    expect(hasActiveExports(undefined)).toBe(false);
  });

  it('descarga solo listos y sin vencer', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    expect(canDownload({ status: 'done', expiresAt: '2026-10-10T00:00:00Z' }, now)).toBe(true);
    expect(canDownload({ status: 'done', expiresAt: '2026-10-01T00:00:00Z' }, now)).toBe(false);
    expect(canDownload({ status: 'done', expiresAt: null }, now)).toBe(true);
    expect(canDownload({ status: 'running', expiresAt: null }, now)).toBe(false);
  });

  it('nombre de archivo de respaldo y tamaños', () => {
    expect(exportFilename(job)).toBe('reporte-sales-items-2026-09-01-a-2026-09-30.xlsx');
    expect(exportFilename({ ...job, filename: 'a.pdf' })).toBe('a.pdf');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2,0 KB');
    expect(formatBytes(null)).toBe('—');
  });

  it('solo reportes que puede leer y con reports.export', () => {
    const perms = new Set(['reports.export', 'reports.sales.read']);
    expect(exportableReports((p) => perms.has(p))).toEqual(['sales', 'sales_items']);
    expect(exportableReports((p) => p === 'reports.sales.read')).toEqual([]);
  });
});
