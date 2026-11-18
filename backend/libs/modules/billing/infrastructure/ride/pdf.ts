/**
 * PDF 1.4 escrito a mano (el mismo enfoque que la guía del courier simulado): páginas con texto
 * en Helvetica / Helvetica-Bold (fuentes estándar, no se incrustan, WinAnsi = latin1),
 * rectángulos y líneas. Suficiente para el RIDE; sin dependencias.
 */

/** Anchos de Helvetica (1/1000 em) de los caracteres que más se alinean a la derecha. */
const WIDTHS: Record<string, number> = { ' ': 278, '.': 278, ',': 278, '-': 333, '$': 556, '%': 889, '/': 278, ':': 278, '#': 556 };
for (const d of '0123456789') WIDTHS[d] = 556;

/** Ancho aproximado del texto (exacto para números; promedio para letras). */
export function textWidth(value: string, size: number, bold = false): number {
  let units = 0;
  for (const ch of value) units += WIDTHS[ch] ?? (ch === ch.toUpperCase() && /\p{L}/u.test(ch) ? 667 : 530);
  return (units * size * (bold ? 1.05 : 1)) / 1000;
}

/** String literal de PDF en WinAnsi: escapa \ ( ) y reemplaza lo que no está en latin1. */
function pdfString(value: string): string {
  return value.replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);
}

export function wrap(value: string, maxChars: number, maxLines: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  const out = lines.map((l) => (l.length > maxChars ? `${l.slice(0, maxChars - 3)}...` : l));
  if (out.length > maxLines) {
    out.length = maxLines;
    out[maxLines - 1] = `${out[maxLines - 1].slice(0, maxChars - 3)}...`;
  }
  return out;
}

export class PdfPage {
  readonly ops: string[] = [];

  text(x: number, y: number, size: number, value: string, opts: { bold?: boolean; align?: 'left' | 'right' | 'center' } = {}): void {
    const w = opts.align && opts.align !== 'left' ? textWidth(value, size, opts.bold) : 0;
    const dx = opts.align === 'right' ? -w : opts.align === 'center' ? -w / 2 : 0;
    this.ops.push(`BT /${opts.bold ? 'F2' : 'F1'} ${size} Tf ${(x + dx).toFixed(2)} ${y.toFixed(2)} Td (${pdfString(value)}) Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.6): void {
    this.ops.push(`${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  /** Rectángulo por su esquina inferior izquierda. */
  rect(x: number, y: number, w: number, h: number, opts: { fill?: number; stroke?: boolean } = {}): void {
    if (opts.fill !== undefined) this.ops.push(`${opts.fill} g ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`);
    if (opts.stroke !== false) this.ops.push(`0.6 w ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push(`${x.toFixed(3)} ${y.toFixed(3)} ${w.toFixed(3)} ${h.toFixed(3)} re f`);
  }
}

/** Arma el archivo: catálogo, árbol de páginas, fuentes, contenidos, info, xref y trailer. */
export function buildPdf(pages: PdfPage[], width: number, height: number, title: string): Buffer {
  // 1 catálogo, 2 páginas, 3 y 4 fuentes, 5 info; luego (página, contenido) por cada página.
  const objects: Buffer[] = [];
  const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(' ');
  objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'));
  objects.push(Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`, 'latin1'));
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'));
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', 'latin1'));
  objects.push(Buffer.from(`<< /Title (${pdfString(title)}) /Producer (moda-ecommerce facturacion) >>`, 'latin1'));
  pages.forEach((page, i) => {
    const content = Buffer.from(page.ops.join('\n'), 'latin1');
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + i * 2} 0 R >>`,
        'latin1',
      ),
    );
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')]));
  });

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(offset);
    offset += chunk.length;
    chunks.push(chunk);
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>`,
    'startxref',
    String(offset),
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
