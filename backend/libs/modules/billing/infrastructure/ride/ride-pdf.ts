import { Injectable } from '@nestjs/common';
import { fromCents, toCents } from '../../../../shared-kernel';
import { RideData, RideRenderer } from '../../application/ports';
import { ecuadorDisplayDateTime, sriDate } from '../../domain/dates';
import { PAYMENT_FORM_NAMES } from '../../domain/invoice';
import { formatSequential } from '../../domain/invoice-xml';
import { code128Bars } from './code128';
import { buildPdf, PdfPage, wrap } from './pdf';

const W = 595; // A4
const H = 842;
const M = 30;
const ROW = 12;
/** Filas de detalle que caben en la primera página y en las siguientes (sin el pie de totales). */
const FOOTER_SPACE = 250;

const ENVIRONMENTS: Record<number, string> = { 1: 'PRUEBAS', 2: 'PRODUCCIÓN' };
/** Leyendas de subtotales por código de porcentaje con tarifa 0. */
const ZERO_RATE_LABELS: Record<string, string> = { '0': 'SUBTOTAL 0%', '6': 'SUBTOTAL NO OBJETO DE IVA', '7': 'SUBTOTAL EXENTO DE IVA' };

/** "15.00" → "15" */
const pct = (rate: string) => String(Number(rate));

/**
 * RIDE (Representación Impresa del Documento Electrónico) de la factura o de la nota de crédito
 * (que agrega el comprobante modificado y la razón, y no lleva formas de pago), con el diseño habitual
 * de los RIDE del SRI: emisor a la izquierda, recuadro con RUC, número, autorización y clave
 * de acceso (con su código de barras Code 128) a la derecha, comprador, detalle, información
 * adicional, formas de pago y totales. El detalle continúa en páginas nuevas si no cabe.
 */
export function renderRidePdf(d: RideData): Buffer {
  const creditNote = d.docType === '04';
  const title = creditNote ? 'NOTA DE CRÉDITO' : 'FACTURA';
  const pages: PdfPage[] = [];
  let page = new PdfPage();
  pages.push(page);

  // ------------------------------------------------------------- emisor
  const e = d.emitter;
  page.rect(M, 632, 262, 180);
  page.text(M + 131, 780, 18, (e.nombreComercial ?? e.razonSocial).toUpperCase(), { bold: true, align: 'center' });
  let y = 750;
  const emitterRows: [string, string | null][] = [
    ['', e.razonSocial],
    ['Dir. Matriz:', e.dirMatriz],
    ['Dir. Sucursal:', d.establishmentAddress],
    ['Contribuyente Especial Nro:', e.contribuyenteEspecial],
    ['OBLIGADO A LLEVAR CONTABILIDAD:', e.obligadoContabilidad ? 'SI' : 'NO'],
    ['', e.contribuyenteRimpe],
  ];
  for (const [label, value] of emitterRows) {
    if (!value) continue;
    if (label) {
      page.text(M + 8, y, 7.5, label, { bold: true });
      y -= 10;
    }
    for (const l of wrap(value, 62, 2)) {
      page.text(M + 8, y, 8, l, { bold: !label });
      y -= 10;
    }
    y -= 4;
  }

  // ------------------------------------------------------------- recuadro del comprobante
  const rx = 302;
  const rw = W - M - rx;
  page.rect(rx, 600, rw, 212);
  page.text(rx + 8, 796, 10, `R.U.C.: ${e.ruc}`, { bold: true });
  page.text(rx + 8, 776, 14, title, { bold: true });
  page.text(rx + 8, 760, 9, `No. ${d.establishment}-${d.emissionPoint}-${formatSequential(d.sequential)}`);
  page.text(rx + 8, 742, 8, 'NÚMERO DE AUTORIZACIÓN', { bold: true });
  page.text(rx + 8, 731, 7.2, d.authorizationNumber);
  page.text(rx + 8, 716, 8, 'FECHA Y HORA DE AUTORIZACIÓN:', { bold: true });
  page.text(rx + 150, 716, 8, ecuadorDisplayDateTime(d.authorizedAt));
  page.text(rx + 8, 702, 8, 'AMBIENTE:', { bold: true });
  page.text(rx + 60, 702, 8, ENVIRONMENTS[d.environment] ?? String(d.environment));
  page.text(rx + 8, 690, 8, 'EMISIÓN:', { bold: true });
  page.text(rx + 60, 690, 8, 'NORMAL');
  page.text(rx + 8, 676, 8, 'CLAVE DE ACCESO', { bold: true });
  const { bars, modules } = code128Bars(d.accessKey);
  const moduleW = Math.min(0.78, (rw - 20) / modules);
  const bx = rx + (rw - modules * moduleW) / 2;
  for (const [x, w] of bars) page.fillRect(bx + x * moduleW, 624, w * moduleW, 44);
  page.text(rx + rw / 2, 612, 7.2, d.accessKey, { align: 'center' });

  // ------------------------------------------------------------- comprador
  page.rect(M, 540, W - 2 * M, 52);
  page.text(M + 8, 578, 8, 'Razón Social / Nombres y Apellidos:', { bold: true });
  page.text(M + 160, 578, 8, d.buyer.name.slice(0, 70));
  page.text(M + 8, 564, 8, 'Identificación:', { bold: true });
  page.text(M + 160, 564, 8, d.buyer.idNumber);
  page.text(M + 330, 564, 8, 'Fecha Emisión:', { bold: true });
  page.text(M + 400, 564, 8, sriDate(d.issueDate));
  page.text(M + 8, 550, 8, 'Dirección:', { bold: true });
  page.text(M + 160, 550, 8, (d.buyer.address ?? '').slice(0, 80));

  // ------------------------------------------------------------- comprobante modificado (nota de crédito)
  let detailTop = 528;
  if (d.docType === '04') {
    page.rect(M, 484, W - 2 * M, 50);
    page.text(M + 8, 520, 8, 'Comprobante que se modifica:', { bold: true });
    page.text(M + 160, 520, 8, `FACTURA ${d.modifiedDocument.number}`);
    page.text(M + 330, 520, 8, 'Fecha Emisión (Comprobante a modificar):', { bold: true });
    page.text(W - M - 8, 520, 8, sriDate(d.modifiedDocument.issueDate), { align: 'right' });
    page.text(M + 8, 506, 8, 'Razón de Modificación:', { bold: true });
    wrap(d.reason, 80, 2).forEach((t, i) => page.text(M + 160, 506 - i * 10, 8, t));
    detailTop = 472;
  }

  // ------------------------------------------------------------- detalle
  const cols = { code: M + 4, qty: M + 115, desc: M + 150, unit: M + 405, disc: M + 465, total: W - M - 4 };
  const header = (top: number) => {
    page.rect(M, top - 16, W - 2 * M, 16, { fill: 0.9 });
    page.text(cols.code, top - 11, 7.5, 'Cod. Principal', { bold: true });
    page.text(cols.qty + 20, top - 11, 7.5, 'Cant.', { bold: true, align: 'right' });
    page.text(cols.desc, top - 11, 7.5, 'Descripción', { bold: true });
    page.text(cols.unit, top - 11, 7.5, 'Precio Unitario', { bold: true, align: 'right' });
    page.text(cols.disc, top - 11, 7.5, 'Descuento', { bold: true, align: 'right' });
    page.text(cols.total, top - 11, 7.5, 'Precio Total', { bold: true, align: 'right' });
    return top - 16;
  };
  y = header(detailTop);
  for (const l of d.lines) {
    const desc = wrap(l.description, 52, 2);
    const height = desc.length * ROW + 4;
    if (y - height < 60) {
      page.text(W / 2, 40, 7, 'Continúa en la página siguiente', { align: 'center' });
      page = new PdfPage();
      pages.push(page);
      page.text(M, H - 40, 9, `${title} No. ${d.establishment}-${d.emissionPoint}-${formatSequential(d.sequential)} (continuación)`, { bold: true });
      y = header(H - 50);
    }
    const base = y - 10;
    page.text(cols.code, base, 7.5, l.mainCode);
    page.text(cols.qty + 20, base, 7.5, l.quantity.toFixed(2), { align: 'right' });
    desc.forEach((t, i) => page.text(cols.desc, base - i * ROW, 7.5, t));
    page.text(cols.unit, base, 7.5, Number(l.unitPrice).toFixed(2), { align: 'right' });
    page.text(cols.disc, base, 7.5, Number(l.discount).toFixed(2), { align: 'right' });
    page.text(cols.total, base, 7.5, l.taxBase, { align: 'right' });
    y -= height;
    page.line(M, y, W - M, y, 0.3);
  }

  // ------------------------------------------------------------- pie: adicional, pagos y totales
  if (y < FOOTER_SPACE) {
    page = new PdfPage();
    pages.push(page);
    y = H - 40;
  }
  const top = y - 12;

  // Totales (derecha)
  const totals = totalRows(d);
  const tx = W - M - 200;
  let ty = top;
  for (const [label, value, bold] of totals) {
    page.rect(tx, ty - 13, 200, 13);
    page.text(tx + 4, ty - 9.5, 7.5, label, { bold });
    page.text(W - M - 4, ty - 9.5, 7.5, value, { bold, align: 'right' });
    ty -= 13;
  }

  // Información adicional (izquierda)
  const lw = tx - M - 10;
  let ly = top;
  page.rect(M, ly - 14, lw, 14, { fill: 0.9 });
  page.text(M + 4, ly - 10, 8, 'Información Adicional', { bold: true });
  ly -= 14;
  const infoTop = ly;
  for (const f of d.additionalInfo) {
    const lines = wrap(f.value, 48, 2);
    page.text(M + 4, ly - 10, 7.5, `${f.name}:`, { bold: true });
    lines.forEach((t, i) => page.text(M + 95, ly - 10 - i * 10, 7.5, t));
    ly -= 10 * lines.length + 3;
  }
  page.rect(M, ly - 3, lw, infoTop - ly + 3);
  ly -= 14;

  // Formas de pago (la nota de crédito no las lleva)
  const paymentForms = d.docType === '04' ? [] : d.paymentForms;
  if (paymentForms.length) page.rect(M, ly - 14, lw, 14, { fill: 0.9 });
  if (paymentForms.length) {
    page.text(M + 4, ly - 10, 8, 'Forma de pago', { bold: true });
    page.text(M + lw - 4, ly - 10, 8, 'Valor', { bold: true, align: 'right' });
    ly -= 14;
  }
  for (const p of paymentForms) {
    page.rect(M, ly - 13, lw, 13);
    page.text(M + 4, ly - 9.5, 7, `${p.code} - ${PAYMENT_FORM_NAMES[p.code] ?? ''}`.slice(0, 60));
    page.text(M + lw - 4, ly - 9.5, 7.5, Number(p.total).toFixed(2), { align: 'right' });
    ly -= 13;
  }

  pages.forEach((p, i) => {
    p.text(M, 22, 6.5, d.environment === 1 ? 'Ambiente de PRUEBAS: comprobante sin validez tributaria.' : 'Documento electrónico autorizado por el SRI.');
    p.text(W - M, 22, 6.5, `Página ${i + 1} de ${pages.length}`, { align: 'right' });
  });
  return buildPdf(pages, W, H, `${creditNote ? 'Nota de crédito' : 'Factura'} ${d.establishment}-${d.emissionPoint}-${formatSequential(d.sequential)}`);
}

/** Filas de totales: subtotales por tarifa, descuento, IVA por tarifa, propina y total. */
export function totalRows(d: Pick<RideData, 'lines' | 'discountTotal' | 'total'>): [string, string, boolean][] {
  const baseByCode = new Map<string, { rate: string; base: number; tax: number }>();
  for (const l of d.lines) {
    const g = baseByCode.get(l.taxRateCode) ?? { rate: l.taxRate, base: 0, tax: 0 };
    g.base += toCents(l.taxBase);
    g.tax += toCents(l.taxAmount);
    baseByCode.set(l.taxRateCode, g);
  }
  const taxed = [...baseByCode].filter(([, g]) => Number(g.rate) > 0).sort((a, b) => Number(b[1].rate) - Number(a[1].rate));
  const rows: [string, string, boolean][] = [];
  for (const [, g] of taxed) rows.push([`SUBTOTAL ${pct(g.rate)}%`, fromCents(g.base), false]);
  for (const code of ['0', '6', '7']) rows.push([ZERO_RATE_LABELS[code], fromCents(baseByCode.get(code)?.base ?? 0), false]);
  const base = [...baseByCode.values()].reduce((s, g) => s + g.base, 0);
  rows.push(['SUBTOTAL SIN IMPUESTOS', fromCents(base), false]);
  rows.push(['TOTAL DESCUENTO', fromCents(toCents(d.discountTotal)), false]);
  if (!taxed.length) rows.push(['IVA 15%', '0.00', false]);
  for (const [, g] of taxed) rows.push([`IVA ${pct(g.rate)}%`, fromCents(g.tax), false]);
  rows.push(['PROPINA', '0.00', false]);
  rows.push(['VALOR TOTAL', fromCents(toCents(d.total)), true]);
  return rows;
}

@Injectable()
export class PdfRideRenderer extends RideRenderer {
  render(data: RideData): Buffer {
    return renderRidePdf(data);
  }
}
