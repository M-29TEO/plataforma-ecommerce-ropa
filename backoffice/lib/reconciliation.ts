/**
 * Conciliación de transferencias contra el extracto bancario (CSV), todo en el navegador: el
 * archivo nunca se sube. Funciones puras: lectura de montos y fechas en los formatos de los
 * bancos ecuatorianos, detección de columnas, extracción de créditos y asignación pago ↔ línea.
 */

// ---------------------------------------------------------------- Tipos del API (/v1/payments)
export interface TransferInfo {
  expectedReference: string;
  bankName: string | null;
  reference: string | null;
  orderNumber: string | null;
  voucherSubmittedAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  rejectionReason: string | null;
}

/** Ítem de GET /v1/payments?method=transfer (arreglo, del más nuevo al más viejo). */
export interface TransferPayment {
  id: string;
  orderId: string;
  method: string;
  amount: string;
  currency: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  capturedAt: string | null;
  failureMessage: string | null;
  transfer: TransferInfo | null;
}

/** pending = comprobante subido, esperando revisión. Historial: aprobadas (captured y sus reembolsos) y rechazadas (failed). */
export const PENDING_STATUSES = ['pending'] as const;
export const HISTORY_STATUSES = ['captured', 'refunded', 'partially_refunded', 'failed'] as const;

// ---------------------------------------------------------------- Texto, montos y fechas
/** Mayúsculas, sin tildes y solo letras y números (para buscar referencias dentro de una descripción). */
export function normalizeRef(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Monto en centavos. Acepta coma o punto decimal y separador de miles ("1.234,56", "1,234.56",
 * "12,5", "$ 12.50", "USD 12.50"); negativo con "-" o entre paréntesis. null si no es un número.
 */
export function parseAmountCents(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/USD|US\$|\$|\s/gi, '');
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let decimalSep: ',' | '.' | null = null;
  if (lastComma >= 0 && lastDot >= 0) decimalSep = lastComma > lastDot ? ',' : '.';
  else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const parts = s.split(sep);
    // Un solo separador seguido de exactamente 3 dígitos y sin más grupos ambiguos: "1.234" = miles.
    const thousands = parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length > 0 && parts[0] !== '0');
    decimalSep = thousands ? null : sep;
  }
  let intPart = s;
  let decPart = '';
  if (decimalSep) {
    const at = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, at);
    decPart = s.slice(at + 1);
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (!/^\d*$/.test(decPart)) return null;
  const cents = Number(intPart || '0') * 100 + Math.round(Number(`0.${decPart || '0'}`) * 100);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

/**
 * Fecha AAAA-MM-DD. Acepta "AAAA-MM-DD", "DD/MM/AAAA", "DD-MM-AAAA", "DD/MM/AA" (con o sin hora
 * después) y "DD-mmm-AAAA" con el mes abreviado en español o inglés. Los bancos de Ecuador usan
 * día/mes: "03/04/2026" es 3 de abril.
 */
export function parseStatementDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const valid = (y: number, m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  };
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return valid(y, +m[2], +m[1]);
  }
  m = /^(\d{1,2})[-/ ]([a-záéíóú]{3,})\.?[-/ ](\d{2,4})\b/.exec(s);
  if (m) {
    const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const en = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const key = m[2].slice(0, 3).replace('á', 'a').replace('é', 'e');
    let month = months.indexOf(key);
    if (month < 0) month = en.indexOf(key);
    if (month < 0) return null;
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return valid(y, month + 1, +m[1]);
  }
  return null;
}

/** Días entre dos fechas AAAA-MM-DD (valor absoluto). */
export function daysBetween(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000));
}

// ---------------------------------------------------------------- Columnas del extracto
export interface ColumnMapping {
  date: string | null;
  /** Monto del movimiento: una columna con signo (Monto/Valor) o solo créditos (Crédito). */
  amount: string | null;
  /** Columna de débitos cuando el banco separa Débito/Crédito: las filas con débito se descartan. */
  debit: string | null;
  /** Indicador de tipo (C/D, Crédito/Débito, Depósito/Retiro) cuando el monto no lleva signo. */
  type: string | null;
  /** Columnas con texto donde buscar la referencia (se concatenan). */
  description: string[];
}

const norm = (h: string) =>
  h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const DATE_NAMES = ['fecha', 'fechacontable', 'fechatransaccion', 'fechamovimiento', 'fechaefectiva', 'date'];
const CREDIT_NAMES = ['credito', 'creditos', 'abono', 'abonos', 'deposito', 'depositos', 'ingreso', 'ingresos', 'haber', 'credit'];
const AMOUNT_NAMES = ['monto', 'valor', 'importe', 'cantidad', 'amount', 'montousd', 'valorusd'];
const DEBIT_NAMES = ['debito', 'debitos', 'cargo', 'cargos', 'retiro', 'retiros', 'egreso', 'egresos', 'debe', 'debit'];
const TYPE_NAMES = ['tipo', 'tipomovimiento', 'tipotransaccion', 'naturaleza', 'cd', 'signo', 'type'];
const DESC_NAMES = [
  'referencia',
  'descripcion',
  'concepto',
  'detalle',
  'observacion',
  'observaciones',
  'documento',
  'numdocumento',
  'nodocumento',
  'beneficiario',
  'ordenante',
  'transaccion',
  'description',
  'reference',
];

function findColumn(headers: string[], names: string[]): string | null {
  const n = headers.map(norm);
  for (const name of names) {
    const i = n.indexOf(name);
    if (i >= 0) return headers[i];
  }
  for (const name of names) {
    const i = n.findIndex((h) => h.startsWith(name));
    if (i >= 0) return headers[i];
  }
  return null;
}

/** Autodetección por los nombres que usan los bancos de Ecuador (Pichincha, Guayaquil, Produbanco, Pacífico...). */
export function detectColumns(headers: string[]): ColumnMapping {
  const date = findColumn(headers, DATE_NAMES);
  const credit = findColumn(headers, CREDIT_NAMES);
  const plain = findColumn(headers, AMOUNT_NAMES);
  const amount = credit ?? plain;
  const debit = credit ? findColumn(headers, DEBIT_NAMES) : null;
  const type = credit ? null : findColumn(headers, TYPE_NAMES);
  const used = new Set([date, amount, debit, type]);
  const n = headers.map(norm);
  const description = headers.filter((h, i) => !used.has(h) && DESC_NAMES.some((d) => n[i] === d || n[i].startsWith(d)));
  return { date, amount, debit, type, description };
}

/**
 * Fila del encabezado: los extractos suelen traer antes datos de la cuenta. Es la primera fila
 * (de las 30 primeras) que tiene una columna de fecha y una de monto; 0 si ninguna.
 */
export function locateHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const m = detectColumns(rows[i].map((c) => String(c ?? '').trim()));
    if (m.date && m.amount) return i;
  }
  return 0;
}

export interface StatementLine {
  /** Índice de la fila en el extracto (para mostrarla y no usarla dos veces). */
  index: number;
  date: string | null;
  amountCents: number;
  description: string;
}

function isDebitType(value: string): boolean {
  const v = norm(value);
  return v === 'd' || v === 'db' || v === 'dr' || v === '-' || v.startsWith('deb') || v.startsWith('ret') || v.startsWith('cargo') || v.startsWith('egr');
}

/** Solo los créditos (dinero que entra) del extracto. */
export function extractCredits(rows: Record<string, string>[], mapping: ColumnMapping): StatementLine[] {
  if (!mapping.amount) return [];
  const out: StatementLine[] = [];
  rows.forEach((row, index) => {
    const amount = parseAmountCents(row[mapping.amount!]);
    if (amount === null || amount <= 0) return;
    if (mapping.debit) {
      const debit = parseAmountCents(row[mapping.debit]);
      if (debit !== null && debit !== 0 && mapping.debit !== mapping.amount) return;
    }
    if (mapping.type && isDebitType(row[mapping.type] ?? '')) return;
    out.push({
      index,
      date: mapping.date ? parseStatementDate(row[mapping.date]) : null,
      amountCents: amount,
      description: mapping.description
        .map((c) => (row[c] ?? '').trim())
        .filter(Boolean)
        .join(' · '),
    });
  });
  return out;
}

// ---------------------------------------------------------------- Asignación pago ↔ línea
export type MatchKind = 'exact' | 'probable' | 'none';

export interface PaymentToMatch {
  id: string;
  amountCents: number;
  expectedReference: string;
  customerReference: string | null;
  orderNumber: string | null;
  /** AAAA-MM-DD en la zona de la tienda (comprobante subido o pago creado). */
  date: string | null;
}

export interface MatchResult {
  paymentId: string;
  kind: MatchKind;
  line: StatementLine | null;
  /** Por qué se emparejó (texto para la tabla). */
  reasons: string[];
}

/** Las referencias del cliente o números de pedido muy cortos coinciden por casualidad. */
const MIN_REF_LENGTH = 4;

function contains(haystack: string, needle: string | null): boolean {
  const n = normalizeRef(needle);
  return n.length >= MIN_REF_LENGTH && haystack.includes(n);
}

interface Candidate {
  payment: number;
  line: number;
  kind: Exclude<MatchKind, 'none'>;
  score: number;
  dayGap: number;
  reasons: string[];
}

function evaluate(p: PaymentToMatch, l: StatementLine): Omit<Candidate, 'payment' | 'line'> | null {
  if (p.amountCents !== l.amountCents) return null;
  const desc = normalizeRef(l.description);
  const dayGap = p.date && l.date ? daysBetween(p.date, l.date) : Infinity;
  const expected = normalizeRef(p.expectedReference);
  if (expected && desc.includes(expected)) {
    return { kind: 'exact', score: 100, dayGap, reasons: ['Referencia esperada en la descripción', 'Monto exacto'] };
  }
  const reasons = ['Monto exacto'];
  let score = 0;
  if (contains(desc, p.customerReference)) {
    score += 20;
    reasons.push('Referencia del cliente en la descripción');
  }
  if (contains(desc, p.orderNumber)) {
    score += 20;
    reasons.push('Número de pedido en la descripción');
  }
  if (dayGap <= 3) {
    score += 10 - dayGap;
    reasons.push(dayGap === 0 ? 'Mismo día' : `Fecha a ${dayGap} día(s)`);
  }
  if (score === 0) return null;
  return { kind: 'probable', score, dayGap, reasons };
}

/**
 * Empareja pagos con líneas del extracto. Exacto: la referencia esperada aparece en la descripción
 * y el monto coincide al centavo. Probable: el monto coincide y aparece la referencia del cliente
 * o el número de pedido, o la fecha está a ±3 días. Cada línea se usa una sola vez: se asignan
 * primero las parejas más fuertes (voraz), así un exacto nunca pierde su línea ante un probable.
 */
export function matchTransfers(payments: PaymentToMatch[], lines: StatementLine[]): { results: MatchResult[]; unmatchedLines: StatementLine[] } {
  const candidates: Candidate[] = [];
  payments.forEach((p, pi) =>
    lines.forEach((l, li) => {
      const c = evaluate(p, l);
      if (c) candidates.push({ ...c, payment: pi, line: li });
    }),
  );
  candidates.sort((a, b) => b.score - a.score || a.dayGap - b.dayGap || a.payment - b.payment || a.line - b.line);

  const byPayment = new Map<number, Candidate>();
  const usedLines = new Set<number>();
  for (const c of candidates) {
    if (byPayment.has(c.payment) || usedLines.has(c.line)) continue;
    byPayment.set(c.payment, c);
    usedLines.add(c.line);
  }

  const results = payments.map((p, pi): MatchResult => {
    const c = byPayment.get(pi);
    return c ? { paymentId: p.id, kind: c.kind, line: lines[c.line], reasons: c.reasons } : { paymentId: p.id, kind: 'none', line: null, reasons: [] };
  });
  return { results, unmatchedLines: lines.filter((_, li) => !usedLines.has(li)) };
}

/** Total de los pagos exactos (para la confirmación de "Aprobar todos los exactos"). */
export function sumCents(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
