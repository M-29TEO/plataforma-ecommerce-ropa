import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { ReportDocument, ReportRenderer } from '../../application/ports';
import { ExportFormat } from '../../domain/export-job';
import { ColumnType, ReportMetrics } from '../../domain/report-rows';

const TZ = 'America/Guayaquil';

const EXCEL_FORMATS: Record<ColumnType, string | undefined> = {
  text: undefined,
  int: '#,##0',
  money: '"$"#,##0.00',
  percent: '0.00"%"',
  minutes: '#,##0',
  decimal: '0.00',
};

function generatedLabel(at: Date): string {
  const text = new Intl.DateTimeFormat('es-EC', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(at);
  return `Generado el ${text} (hora de Ecuador)`;
}

/** Valor de celda: números como número (Excel puede sumarlos); null queda vacío. */
function cellValue(type: ColumnType, value: string | number | null | undefined): string | number | null {
  if (value === null || value === undefined) return null;
  return type === 'text' ? String(value) : Number(value);
}

/** Texto para el PDF. */
export function formatValue(type: ColumnType, value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const n = Number(value);
  switch (type) {
    case 'money':
      return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'percent':
      return `${n.toFixed(2)} %`;
    case 'decimal':
      return n.toFixed(2);
    case 'int':
    case 'minutes':
      return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    default:
      return String(value);
  }
}

/** Excel con ExcelJS y PDF con pdfkit (fuentes estándar, sin archivos externos). */
@Injectable()
export class ExcelPdfReportRenderer extends ReportRenderer {
  render(format: ExportFormat, doc: ReportDocument): Promise<Buffer> {
    return format === 'xlsx' ? this.xlsx(doc) : this.pdf(doc);
  }

  private async xlsx(doc: ReportDocument): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'moda-ecommerce';
    wb.created = doc.generatedAt;
    const ws = wb.addWorksheet('Reporte');
    const width = doc.columns.length + 1;

    ws.addRow([doc.title]).font = { bold: true, size: 14 };
    ws.addRow([doc.subtitle]);
    ws.addRow([generatedLabel(doc.generatedAt) + (doc.truncated ? ` · se exportaron las primeras ${doc.rows.length} filas` : '')]);
    ws.addRow([]);
    const header = ws.addRow([doc.groupHeader, ...doc.columns.map((c) => c.header)]);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    const headerRow = header.number;

    for (const row of doc.rows) ws.addRow([row.label, ...doc.columns.map((c) => cellValue(c.type, row[c.field]))]);
    const totals = ws.addRow(['Total', ...doc.columns.map((c) => cellValue(c.type, doc.totals[c.field]))]);
    totals.font = { bold: true };
    totals.eachCell((cell) => (cell.border = { top: { style: 'thin' } }));

    ws.getColumn(1).width = 34;
    doc.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 2);
      col.width = Math.max(12, c.header.length + 2);
      col.numFmt = EXCEL_FORMATS[c.type] ?? '';
    });
    ws.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 1 }];
    ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + doc.rows.length, column: width } };

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private pdf(doc: ReportDocument): Promise<Buffer> {
    const margin = 36;
    const pdf = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin,
      bufferPages: true,
      info: { Title: `${doc.title} - ${doc.subtitle}`, Producer: 'moda-ecommerce reportes' },
    });
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      pdf.on('data', (c: Buffer) => chunks.push(c));
      pdf.on('end', () => resolve(Buffer.concat(chunks)));
      pdf.on('error', reject);
    });

    const pageW = pdf.page.width;
    const pageH = pdf.page.height;
    const usable = pageW - margin * 2;
    const firstW = Math.min(170, usable * 0.24);
    const colW = (usable - firstW) / doc.columns.length;
    const fontSize = doc.columns.length > 10 ? 7 : 8;
    const rowH = fontSize + 7;
    const xs = [margin, ...doc.columns.map((_, i) => margin + firstW + i * colW)];
    const widths = [firstW, ...doc.columns.map(() => colW)];

    const fit = (text: string, w: number) => {
      if (pdf.widthOfString(text) <= w) return text;
      let t = text;
      while (t.length > 1 && pdf.widthOfString(`${t}...`) > w) t = t.slice(0, -1);
      return `${t}...`;
    };

    const drawHeader = (y: number): number => {
      pdf.font('Helvetica-Bold').fontSize(fontSize);
      const labels = [doc.groupHeader, ...doc.columns.map((c) => c.header)];
      const h = Math.max(...labels.map((l, i) => pdf.heightOfString(l, { width: widths[i] - 6 }))) + 8;
      pdf.rect(margin, y, usable, h).fill('#1F2937');
      pdf.fillColor('#FFFFFF');
      labels.forEach((l, i) => pdf.text(l, xs[i] + 3, y + 4, { width: widths[i] - 6, align: i === 0 ? 'left' : 'right' }));
      pdf.fillColor('#000000');
      return y + h;
    };

    const drawRow = (y: number, label: string, metrics: ReportMetrics, opts: { bold?: boolean; shade?: boolean }) => {
      if (opts.shade) pdf.rect(margin, y, usable, rowH).fill('#F3F4F6').fillColor('#000000');
      pdf.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
      pdf.text(fit(label, firstW - 6), xs[0] + 3, y + 3.5, { width: firstW - 6, lineBreak: false });
      doc.columns.forEach((c, i) =>
        pdf.text(fit(formatValue(c.type, metrics[c.field]), colW - 6), xs[i + 1] + 3, y + 3.5, {
          width: colW - 6,
          align: 'right',
          lineBreak: false,
        }),
      );
    };

    pdf.font('Helvetica-Bold').fontSize(16).text(doc.title, margin, margin);
    pdf.font('Helvetica').fontSize(10).fillColor('#374151').text(doc.subtitle);
    pdf.fontSize(8).text(generatedLabel(doc.generatedAt) + (doc.truncated ? ` · primeras ${doc.rows.length} filas` : ''));
    pdf.fillColor('#000000');
    let y = drawHeader(pdf.y + 10);
    const bottom = pageH - margin - 14;

    doc.rows.forEach((row, i) => {
      if (y + rowH > bottom) {
        pdf.addPage();
        y = drawHeader(margin);
      }
      drawRow(y, row.label, row, { shade: i % 2 === 1 });
      y += rowH;
    });
    if (y + rowH + 2 > bottom) {
      pdf.addPage();
      y = drawHeader(margin);
    }
    pdf.moveTo(margin, y + 1).lineTo(margin + usable, y + 1).lineWidth(0.8).stroke();
    drawRow(y + 2, 'Total', doc.totals, { bold: true });

    const range = pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      pdf.switchToPage(range.start + i);
      // El pie va dentro del margen inferior: sin esto pdfkit lo pasaría a una página nueva.
      pdf.page.margins.bottom = 0;
      pdf.font('Helvetica').fontSize(7).fillColor('#6B7280');
      pdf.text(`Página ${i + 1} de ${range.count}`, margin, pageH - margin - 6, { width: usable, align: 'right', lineBreak: false });
    }
    pdf.end();
    return done;
  }
}
