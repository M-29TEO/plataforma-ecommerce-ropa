import ExcelJS from 'exceljs';
import { ReportDocument } from '../../application/ports';
import { METRIC_COLUMNS, toMetrics, ZERO_AGGREGATE } from '../../domain/report-rows';
import { ExcelPdfReportRenderer, formatValue } from './report-renderer';

function doc(rows: number): ReportDocument {
  return {
    title: 'Ventas',
    subtitle: 'Por método de pago · del 2026-09-01 al 2026-09-30',
    generatedAt: new Date('2026-10-01T15:00:00Z'),
    groupHeader: 'Método de pago',
    columns: METRIC_COLUMNS.sales,
    rows: Array.from({ length: rows }, (_, i) => ({
      key: `k${i}`,
      label: i === 0 ? 'Contra entrega' : `Fila ñandú ${i}`,
      ...toMetrics('sales', {
        orders: 2, units: 3, gross_sales: '115.00', net_sales: '100.00', returns: '0.00', cost: '40.00',
        net_sales_costed: '100.00', margin: '60.00', average_ticket: '57.50',
      }),
    })),
    totals: toMetrics('sales', { ...ZERO_AGGREGATE.sales, orders: 2 * rows, net_sales: '1234.50', margin: '-5.00', net_sales_costed: '100.00' }),
    truncated: false,
  };
}

describe('ExcelPdfReportRenderer', () => {
  const renderer = new ExcelPdfReportRenderer();

  it('Excel: encabezado, filas con números reales, fila de totales y formatos de moneda', async () => {
    const buf = await renderer.render('xlsx', doc(3));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Reporte')!;
    expect(ws.getCell('A1').value).toBe('Ventas');
    expect(ws.getRow(5).getCell(1).value).toBe('Método de pago');
    expect(ws.getRow(5).getCell(4).value).toBe('Ventas brutas');
    expect(ws.getRow(6).getCell(1).value).toBe('Contra entrega');
    expect(ws.getRow(6).getCell(5).value).toBe(100); // ventas netas como número
    expect(ws.getRow(6).getCell(5).numFmt).toBe('"$"#,##0.00');
    expect(ws.getRow(9).getCell(1).value).toBe('Total');
    expect(ws.getRow(9).getCell(2).value).toBe(6);
    expect(ws.getRow(9).getCell(10).value).toBeNull(); // ticket promedio sin pedidos de base
  });

  it('PDF: archivo válido y paginado cuando no caben las filas', async () => {
    const one = await renderer.render('pdf', doc(5));
    const many = await renderer.render('pdf', doc(120));
    expect(one.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pages = (b: Buffer) => (b.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages(one)).toBe(1);
    expect(pages(many)).toBeGreaterThan(2);
  });

  it('formato de valores del PDF', () => {
    expect(formatValue('money', '1234.5')).toBe('$1,234.50');
    expect(formatValue('percent', 37.5)).toBe('37.50 %');
    expect(formatValue('int', 12000)).toBe('12,000');
    expect(formatValue('percent', null)).toBe('-');
  });
});
