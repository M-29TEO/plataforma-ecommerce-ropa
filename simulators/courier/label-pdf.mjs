// Guía de envío en PDF (etiqueta 4×6 pulgadas) escrita a mano, sin librerías: un PDF 1.4 con
// una página, las fuentes estándar Helvetica/Helvetica-Bold (no se incrustan) y un código de
// barras Code 39 dibujado con rectángulos. Suficiente para imprimir y escanear en la demo.

/** Code 39: 9 elementos por carácter (barra, espacio, barra...), 3 de ellos anchos (w). */
export const CODE39 = {
  0: 'nnnwwnwnn', 1: 'wnnwnnnnw', 2: 'nnwwnnnnw', 3: 'wnwwnnnnn', 4: 'nnnwwnnnw',
  5: 'wnnwwnnnn', 6: 'nnwwwnnnn', 7: 'nnnwnnwnw', 8: 'wnnwnnwnn', 9: 'nnwwnnwnn',
  A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn',
  F: 'nnwnwwnnn', G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn',
  K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn', N: 'nnnnwnnww', O: 'wnnnwnnwn',
  P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn',
  U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn',
  Z: 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn',
};

/**
 * Barras de un Code 39 como rectángulos [x, ancho] relativos al inicio. Se delimita con '*'
 * (inicio y fin) y entre caracteres va un espacio angosto.
 */
export function code39Bars(text, narrow = 0.9, wide = 2.2) {
  const value = `*${String(text).toUpperCase()}*`;
  const bars = [];
  let x = 0;
  for (const ch of value) {
    const pattern = CODE39[ch];
    if (!pattern) throw new Error(`Carácter no soportado por Code 39: "${ch}"`);
    [...pattern].forEach((el, i) => {
      const w = el === 'w' ? wide : narrow;
      if (i % 2 === 0) bars.push([x, w]);
      x += w;
    });
    x += narrow;
  }
  return { bars, width: x - narrow };
}

// ------------------------------------------------------------------ PDF de bajo nivel

/** Texto para un string literal de PDF en WinAnsi (latin1): escapa \ ( ) y reemplaza lo demás. */
function pdfText(value) {
  return String(value ?? '')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
    .replace(/[\\()]/g, (c) => `\\${c}`);
}

function wrap(text, maxChars, maxLines) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, maxChars - 3)}...`;
  }
  return lines;
}

/** Arma el archivo: objetos numerados, tabla xref con los offsets en bytes y trailer. */
function buildPdf(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
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
    `<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>`,
    'startxref',
    String(offset),
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

const PAGE_W = 288; // 4 in
const PAGE_H = 432; // 6 in

/**
 * Guía del envío. `shipment` es el registro del simulador (trackingNumber, service, sender,
 * recipient, weightKg, packages, codAmount, reference, createdAt).
 */
export function renderLabelPdf(shipment) {
  const ops = [];
  const text = (x, y, size, value, bold = false) =>
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${pdfText(value)}) Tj ET`);
  const line = (x1, y1, x2, y2, width = 1) => ops.push(`${width} w ${x1} ${y1} m ${x2} ${y2} l S`);

  const m = 16;
  // Encabezado
  ops.push(`0 g ${m} ${PAGE_H - 52} ${PAGE_W - 2 * m} 36 re f`);
  ops.push('1 g');
  text(m + 8, PAGE_H - 30, 13, 'COURIER SIMULADO', true);
  text(m + 8, PAGE_H - 45, 9, `Servicio ${shipment.serviceName ?? shipment.serviceCode}`);
  ops.push('0 g');

  // Número de guía y código de barras
  text(m, PAGE_H - 72, 9, 'GUIA No.');
  text(m, PAGE_H - 90, 17, shipment.trackingNumber, true);
  const { bars, width } = code39Bars(shipment.trackingNumber);
  const bx = (PAGE_W - width) / 2;
  const by = PAGE_H - 150;
  for (const [x, w] of bars) ops.push(`${(bx + x).toFixed(2)} ${by} ${w.toFixed(2)} 48 re f`);
  line(m, by - 10, PAGE_W - m, by - 10);

  // Remitente
  let y = by - 26;
  text(m, y, 8, 'REMITENTE', true);
  const s = shipment.sender ?? {};
  for (const l of [s.name, ...wrap(s.address, 52, 2), [s.city, s.phone].filter(Boolean).join(' - ')]) {
    if (!l) continue;
    y -= 11;
    text(m, y, 8, l);
  }
  y -= 10;
  line(m, y, PAGE_W - m, y);

  // Destinatario (lo que más se lee: más grande)
  y -= 16;
  text(m, y, 8, 'DESTINATARIO', true);
  const r = shipment.recipient ?? {};
  y -= 15;
  text(m, y, 12, r.name ?? '', true);
  for (const l of wrap(r.address, 42, 3)) {
    y -= 13;
    text(m, y, 10, l);
  }
  if (r.phone) {
    y -= 13;
    text(m, y, 10, `Tel. ${r.phone}`);
  }
  y -= 20;
  text(m, y, 14, [r.city, r.province].filter(Boolean).join(' / ').toUpperCase(), true);
  y -= 12;
  line(m, y, PAGE_W - m, y);

  // Datos del paquete
  y -= 16;
  const cod = Number(shipment.codAmount ?? 0);
  text(m, y, 9, `Peso: ${Number(shipment.chargeableKg ?? shipment.weightKg).toFixed(1)} kg`);
  text(m + 95, y, 9, `Bultos: ${shipment.packages ?? 1}`);
  text(m + 170, y, 9, `Ref: ${shipment.reference ?? ''}`);
  y -= 24;
  if (cod > 0) {
    ops.push(`${m} ${y - 6} ${PAGE_W - 2 * m} 20 re S`);
    text(m + 6, y, 11, `COBRAR CONTRA ENTREGA: USD ${cod.toFixed(2)}`, true);
  } else {
    text(m, y, 9, 'Sin cobro contra entrega');
  }

  // Pie
  const created = new Date(shipment.createdAt ?? Date.now());
  text(m, 30, 7, `Emitida: ${created.toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}`);
  text(m, 18, 7, 'Documento SIMULADO para desarrollo - sin validez comercial.');

  const content = Buffer.from(ops.join('\n'), 'latin1');
  const info = `<< /Title (${pdfText(`Guia ${shipment.trackingNumber}`)}) /Producer (moda-couriersim) >>`;
  return buildPdf([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
      'latin1',
    ),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', 'latin1'),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')]),
    Buffer.from(info, 'latin1'),
  ]);
}
