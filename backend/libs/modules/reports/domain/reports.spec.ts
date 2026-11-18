import { exportErrorMessage, exportFilename, exportStorageKey } from './export-job';
import { localDate, percent, previousRange, rangeDays, resolveQuery, resolveRange } from './report';
import { displayLabel, METRIC_COLUMNS, timeBuckets, toMetrics, weekStart, ZERO_AGGREGATE } from './report-rows';

// 2026-10-01 03:00 UTC = 2026-09-30 22:00 en Guayaquil (UTC-5).
const NOW = new Date('2026-10-01T03:00:00Z');

describe('rangos de fechas', () => {
  it('la fecha local es la de Guayaquil, no la UTC', () => {
    expect(localDate(NOW)).toBe('2026-09-30');
  });

  it('sin fechas: los últimos 30 días hasta hoy (ambos incluidos)', () => {
    expect(resolveRange({}, NOW)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(rangeDays(resolveRange({}, NOW))).toBe(30);
  });

  it('solo to: 30 días hacia atrás desde to', () => {
    expect(resolveRange({ to: '2026-03-01' }, NOW)).toEqual({ from: '2026-01-31', to: '2026-03-01' });
  });

  it('rechaza from > to, fechas imposibles y rangos de más de 2 años', () => {
    expect(() => resolveRange({ from: '2026-09-10', to: '2026-09-01' }, NOW)).toThrow(expect.objectContaining({ code: 'INVALID_RANGE' }));
    expect(() => resolveRange({ from: '2026-02-30', to: '2026-03-01' }, NOW)).toThrow(expect.objectContaining({ code: 'INVALID_DATE' }));
    expect(() => resolveRange({ from: '2023-01-01', to: '2026-01-01' }, NOW)).toThrow(expect.objectContaining({ code: 'RANGE_TOO_LONG' }));
  });

  it('un rango de un día es válido', () => {
    expect(rangeDays(resolveRange({ from: '2026-09-15', to: '2026-09-15' }, NOW))).toBe(1);
  });

  it('período anterior del mismo largo, pegado al actual', () => {
    expect(previousRange({ from: '2026-09-01', to: '2026-09-30' })).toEqual({ from: '2026-08-02', to: '2026-08-31' });
    expect(previousRange({ from: '2026-03-01', to: '2026-03-01' })).toEqual({ from: '2026-02-28', to: '2026-02-28' });
  });
});

describe('resolveQuery', () => {
  it('aplica el groupBy por defecto de cada reporte', () => {
    expect(resolveQuery('sales', {}, NOW).groupBy).toBe('day');
    expect(resolveQuery('sales_items', {}, NOW).groupBy).toBe('category');
    expect(resolveQuery('delivery', {}, NOW).groupBy).toBe('courier');
  });

  it('solo acepta las dimensiones del reporte (lista blanca)', () => {
    expect(resolveQuery('sales', { groupBy: 'neighborhood' }, NOW).groupBy).toBe('neighborhood');
    expect(() => resolveQuery('funnel', { groupBy: 'city' }, NOW)).toThrow(expect.objectContaining({ code: 'INVALID_GROUP_BY' }));
    expect(() => resolveQuery('sales', { groupBy: 'city; DROP TABLE x' }, NOW)).toThrow(expect.objectContaining({ code: 'INVALID_GROUP_BY' }));
  });

  it('limit entre 1 y 1000', () => {
    expect(resolveQuery('sales_items', { limit: 5 }, NOW).limit).toBe(5);
    expect(() => resolveQuery('sales_items', { limit: 0 }, NOW)).toThrow(expect.objectContaining({ code: 'INVALID_LIMIT' }));
  });
});

describe('períodos', () => {
  it('weekStart devuelve el lunes ISO', () => {
    expect(weekStart('2026-09-30')).toBe('2026-09-28'); // miércoles
    expect(weekStart('2026-09-28')).toBe('2026-09-28'); // lunes
    expect(weekStart('2026-10-04')).toBe('2026-09-28'); // domingo
  });

  it('timeBuckets cubre todo el rango sin huecos', () => {
    const range = { from: '2026-09-27', to: '2026-10-06' };
    expect(timeBuckets(range, 'day')).toHaveLength(10);
    expect(timeBuckets(range, 'week')).toEqual(['2026-09-21', '2026-09-28', '2026-10-05']);
    expect(timeBuckets(range, 'month')).toEqual(['2026-09', '2026-10']);
  });
});

describe('métricas', () => {
  it('percent con 2 decimales y null sin base', () => {
    expect(percent(1, 3)).toBe(33.33);
    expect(percent(5, 0)).toBeNull();
  });

  it('ventas: margen % sobre las ventas con costo conocido', () => {
    const m = toMetrics('sales', {
      orders: 4, units: 9, gross_sales: '230.00', net_sales: '200.00', returns: '10.00', cost: '60.00',
      net_sales_costed: '150.00', margin: '90.00', average_ticket: '57.50',
    });
    expect(m).toMatchObject({ orders: 4, netSales: '200.00', margin: '90.00', marginPct: 60, averageTicket: '57.50' });
  });

  it('entregas: tasa de entrega sin contar los cancelados y a tiempo sobre los que tenían promesa', () => {
    const m = toMetrics('delivery', {
      ...ZERO_AGGREGATE.delivery, shipments: 11, delivered: 8, cancelled: 1, with_promise: 4, on_time: 3, avg_lead_minutes: 95, rating_avg: 4.5,
    });
    expect(m).toMatchObject({ deliveryRate: 80, onTimeRate: 75, avgLeadMinutes: 95, ratingAvg: 4.5 });
  });

  it('embudo: conversión y abandono sobre los carritos con productos', () => {
    const m = toMetrics('funnel', { ...ZERO_AGGREGATE.funnel, carts_created: 20, carts_with_items: 10, carts_abandoned: 4, orders_paid: 3 });
    expect(m).toMatchObject({ conversionRate: 30, abandonmentRate: 40 });
  });

  it('agregados en cero: tasas y ticket promedio en null, montos en 0.00', () => {
    for (const kind of ['sales', 'sales_items', 'delivery', 'funnel'] as const) {
      const m = toMetrics(kind, ZERO_AGGREGATE[kind]);
      for (const c of METRIC_COLUMNS[kind]) {
        expect(m).toHaveProperty(c.field);
        if (c.type === 'money' && c.field !== 'averageTicket') expect(m[c.field]).toBe('0.00');
        if (c.type === 'percent') expect(m[c.field]).toBeNull();
      }
    }
  });

  it('etiquetas legibles para códigos conocidos', () => {
    expect(displayLabel('payment_method', 'cod')).toBe('Contra entrega');
    expect(displayLabel('city', 'Quito')).toBe('Quito');
  });
});

describe('exportes', () => {
  const job = {
    id: 'j1', tenantId: 't1', report: 'sales_items' as const, format: 'xlsx' as const,
    params: { from: '2026-09-01', to: '2026-09-30', groupBy: 'payment_method', limit: 100 },
  };

  it('clave por tenant y nombre de archivo descriptivo', () => {
    expect(exportStorageKey(job)).toBe('reports/exports/t1/j1.xlsx');
    expect(exportFilename(job)).toBe('reporte-sales-items-payment-method-2026-09-01-a-2026-09-30.xlsx');
  });

  it('el error guardado es una sola línea con tope de largo', () => {
    expect(exportErrorMessage(new Error('falló\n    at algo'))).toBe('falló');
    expect(exportErrorMessage('x'.repeat(900))).toHaveLength(500);
  });
});
