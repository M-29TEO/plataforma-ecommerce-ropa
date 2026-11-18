import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  detectColumns,
  extractCredits,
  locateHeaderRow,
  matchTransfers,
  normalizeRef,
  parseAmountCents,
  parseStatementDate,
  type PaymentToMatch,
  type StatementLine,
} from './reconciliation';

describe('parseAmountCents', () => {
  it.each([
    ['12.50', 1250],
    ['12,50', 1250],
    ['12,5', 1250],
    ['12', 1200],
    ['0.05', 5],
    ['1.234,56', 123456],
    ['1,234.56', 123456],
    ['1.234.567,89', 123456789],
    ['1,234', 123400],
    ['1.234', 123400],
    ['0.500', 50],
    ['$ 45.90', 4590],
    ['USD 45.90', 4590],
    ['+10.00', 1000],
    ['-10.00', -1000],
    ['10.00-', -1000],
    ['(10,00)', -1000],
    [' 1 234,50 ', 123450],
  ])('%s → %i', (raw, cents) => {
    expect(parseAmountCents(raw)).toBe(cents);
  });
  it.each(['', '   ', 'abc', '12a', null, undefined, '.', ','])('%s → null', (raw) => {
    expect(parseAmountCents(raw as string)).toBeNull();
  });
});

describe('parseStatementDate', () => {
  it.each([
    ['2026-10-07', '2026-10-07'],
    ['2026/10/07 14:33', '2026-10-07'],
    ['07/10/2026', '2026-10-07'],
    ['7/10/2026', '2026-10-07'],
    ['07-10-2026', '2026-10-07'],
    ['07.10.2026', '2026-10-07'],
    ['07/10/26', '2026-10-07'],
    ['07/10/2026 08:15:00', '2026-10-07'],
    ['07-oct-2026', '2026-10-07'],
    ['7 Oct 2026', '2026-10-07'],
    ['03-ene-2026', '2026-01-03'],
    ['15-ago-26', '2026-08-15'],
    ['01-dic-2026', '2026-12-01'],
  ])('%s → %s', (raw, iso) => {
    expect(parseStatementDate(raw)).toBe(iso);
  });
  it.each(['', '31/02/2026', '2026-13-01', 'ayer', '07-xyz-2026'])('%s → null', (raw) => {
    expect(parseStatementDate(raw)).toBeNull();
  });
  it('daysBetween', () => {
    expect(daysBetween('2026-10-07', '2026-10-04')).toBe(3);
    expect(daysBetween('2026-10-04', '2026-10-07')).toBe(3);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });
});

describe('normalizeRef', () => {
  it('quita tildes, separadores y pasa a mayúsculas', () => {
    expect(normalizeRef('pago-1a2b 3c4d')).toBe('PAGO1A2B3C4D');
    expect(normalizeRef('Transferencia Ñandú #12')).toBe('TRANSFERENCIANANDU12');
    expect(normalizeRef(null)).toBe('');
  });
});

describe('detectColumns', () => {
  it('Pichincha: Fecha, Concepto, Tipo, Documento, Monto, Saldo', () => {
    const m = detectColumns(['Fecha', 'Concepto', 'Tipo', 'Documento', 'Oficina', 'Monto', 'Saldo']);
    expect(m).toEqual({ date: 'Fecha', amount: 'Monto', debit: null, type: 'Tipo', description: ['Concepto', 'Documento'] });
  });
  it('Produbanco: Débito y Crédito separados', () => {
    const m = detectColumns(['Fecha', 'Referencia', 'Descripción', 'Débito', 'Crédito', 'Saldo']);
    expect(m).toEqual({ date: 'Fecha', amount: 'Crédito', debit: 'Débito', type: null, description: ['Referencia', 'Descripción'] });
  });
  it('Valor y Detalle (otros bancos), sin distinguir mayúsculas ni tildes', () => {
    const m = detectColumns(['FECHA TRANSACCION', 'DETALLE', 'VALOR']);
    expect(m.date).toBe('FECHA TRANSACCION');
    expect(m.amount).toBe('VALOR');
    expect(m.description).toEqual(['DETALLE']);
  });
  it('sin columnas reconocibles', () => {
    expect(detectColumns(['a', 'b'])).toEqual({ date: null, amount: null, debit: null, type: null, description: [] });
  });
  it('locateHeaderRow salta el encabezado de la cuenta', () => {
    const rows = [['Banco Pichincha'], ['Cuenta', '2200000000'], [], ['Fecha', 'Concepto', 'Monto'], ['07/10/2026', 'x', '1.00']];
    expect(locateHeaderRow(rows)).toBe(3);
    expect(locateHeaderRow([['x'], ['y']])).toBe(0);
  });
});

describe('extractCredits', () => {
  it('monto con signo: solo positivos', () => {
    const rows = [
      { Fecha: '07/10/2026', Concepto: 'TRANSF PAGO-AAAA1111', Monto: '25,00' },
      { Fecha: '07/10/2026', Concepto: 'COMISION', Monto: '-0,45' },
      { Fecha: '07/10/2026', Concepto: 'vacío', Monto: '' },
    ];
    const lines = extractCredits(rows, { date: 'Fecha', amount: 'Monto', debit: null, type: null, description: ['Concepto'] });
    expect(lines).toEqual([{ index: 0, date: '2026-10-07', amountCents: 2500, description: 'TRANSF PAGO-AAAA1111' }]);
  });
  it('columna Tipo C/D', () => {
    const rows = [
      { Fecha: '2026-10-07', Concepto: 'A', Tipo: 'C', Monto: '10.00' },
      { Fecha: '2026-10-07', Concepto: 'B', Tipo: 'D', Monto: '10.00' },
      { Fecha: '2026-10-07', Concepto: 'C', Tipo: 'Débito', Monto: '5.00' },
      { Fecha: '2026-10-07', Concepto: 'D', Tipo: 'Crédito', Monto: '7.00' },
    ];
    const lines = extractCredits(rows, { date: 'Fecha', amount: 'Monto', debit: null, type: 'Tipo', description: ['Concepto'] });
    expect(lines.map((l) => l.description)).toEqual(['A', 'D']);
  });
  it('Débito/Crédito separados y descripción de varias columnas', () => {
    const rows = [
      { Fecha: '07/10/2026', Referencia: '123', Descripción: 'PAGO X', Débito: '', Crédito: '30,00' },
      { Fecha: '07/10/2026', Referencia: '124', Descripción: 'RETIRO', Débito: '20,00', Crédito: '' },
    ];
    const lines = extractCredits(rows, { date: 'Fecha', amount: 'Crédito', debit: 'Débito', type: null, description: ['Referencia', 'Descripción'] });
    expect(lines).toEqual([{ index: 0, date: '2026-10-07', amountCents: 3000, description: '123 · PAGO X' }]);
  });
  it('sin columna de monto no hay líneas', () => {
    expect(extractCredits([{ a: '1' }], { date: null, amount: null, debit: null, type: null, description: [] })).toEqual([]);
  });
});

describe('matchTransfers', () => {
  const pay = (id: string, patch: Partial<PaymentToMatch> = {}): PaymentToMatch => ({
    id,
    amountCents: 2500,
    expectedReference: `PAGO-${id.toUpperCase()}`,
    customerReference: null,
    orderNumber: null,
    date: '2026-10-07',
    ...patch,
  });
  const line = (index: number, patch: Partial<StatementLine> = {}): StatementLine => ({ index, date: '2026-10-07', amountCents: 2500, description: '', ...patch });

  it('exacto: referencia esperada (sin importar guiones ni mayúsculas) y monto al centavo', () => {
    const { results, unmatchedLines } = matchTransfers([pay('aaaa1111')], [line(0, { description: 'Transf. pago aaaa1111 de JUAN' })]);
    expect(results[0]).toMatchObject({ paymentId: 'aaaa1111', kind: 'exact', line: { index: 0 } });
    expect(unmatchedLines).toEqual([]);
  });

  it('la referencia con un centavo de diferencia no es exacta ni probable', () => {
    const { results } = matchTransfers([pay('aaaa1111')], [line(0, { description: 'PAGO-AAAA1111', amountCents: 2501, date: null })]);
    expect(results[0].kind).toBe('none');
  });

  it('probable por referencia del cliente', () => {
    const { results } = matchTransfers([pay('a', { customerReference: '00987654', date: null })], [line(0, { description: 'DEP 00987654', date: null })]);
    expect(results[0].kind).toBe('probable');
    expect(results[0].reasons).toContain('Referencia del cliente en la descripción');
  });

  it('probable por número de pedido', () => {
    const { results } = matchTransfers([pay('a', { orderNumber: 'MOD-000123', date: null })], [line(0, { description: 'pedido mod000123', date: null })]);
    expect(results[0].kind).toBe('probable');
  });

  it('probable por fecha a ±3 días; a 4 días no', () => {
    expect(matchTransfers([pay('a')], [line(0, { date: '2026-10-10' })]).results[0].kind).toBe('probable');
    expect(matchTransfers([pay('a')], [line(0, { date: '2026-10-04' })]).results[0].kind).toBe('probable');
    expect(matchTransfers([pay('a')], [line(0, { date: '2026-10-11' })]).results[0].kind).toBe('none');
  });

  it('referencias muy cortas no cuentan (evita coincidencias por casualidad)', () => {
    const { results } = matchTransfers([pay('a', { customerReference: '12', date: null })], [line(0, { description: 'X 12 Y', date: null })]);
    expect(results[0].kind).toBe('none');
  });

  it('una línea no se usa para dos pagos: gana el exacto aunque venga después', () => {
    const payments = [pay('p1'), pay('p2')];
    const lines = [line(0, { description: 'PAGO-P2' })];
    const { results, unmatchedLines } = matchTransfers(payments, lines);
    expect(results.find((r) => r.paymentId === 'p2')).toMatchObject({ kind: 'exact', line: { index: 0 } });
    expect(results.find((r) => r.paymentId === 'p1')).toMatchObject({ kind: 'none', line: null });
    expect(unmatchedLines).toEqual([]);
  });

  it('un pago con dos líneas candidatas toma la más fuerte y deja la otra libre', () => {
    const { results, unmatchedLines } = matchTransfers([pay('p1')], [line(0, { date: '2026-10-09' }), line(1, { description: 'PAGO-P1' })]);
    expect(results[0]).toMatchObject({ kind: 'exact', line: { index: 1 } });
    expect(unmatchedLines.map((l) => l.index)).toEqual([0]);
  });

  it('entre probables por fecha gana la fecha más cercana', () => {
    const { results } = matchTransfers([pay('p1')], [line(0, { date: '2026-10-09' }), line(1, { date: '2026-10-07' })]);
    expect(results[0].line?.index).toBe(1);
  });

  it('voraz global: el probable más fuerte se asigna antes que uno más débil', () => {
    // p1 coincide por referencia del cliente (fuerte) con L0; p2 solo por fecha con L0 y L1.
    const payments = [pay('p2', { date: '2026-10-07' }), pay('p1', { customerReference: 'REF998877', date: null })];
    const lines = [line(0, { description: 'REF998877', date: '2026-10-07' }), line(1, { date: '2026-10-08' })];
    const { results } = matchTransfers(payments, lines);
    expect(results.find((r) => r.paymentId === 'p1')?.line?.index).toBe(0);
    expect(results.find((r) => r.paymentId === 'p2')).toMatchObject({ kind: 'probable', line: { index: 1 } });
  });

  it('montos repetidos: cada pago exacto toma su propia línea', () => {
    const payments = [pay('p1'), pay('p2'), pay('p3')];
    const lines = [line(0, { description: 'PAGO-P3' }), line(1, { description: 'PAGO-P1' }), line(2, { description: 'otro', date: '2026-01-01' })];
    const { results, unmatchedLines } = matchTransfers(payments, lines);
    expect(results.map((r) => [r.paymentId, r.kind, r.line?.index ?? null])).toEqual([
      ['p1', 'exact', 1],
      ['p2', 'none', null],
      ['p3', 'exact', 0],
    ]);
    expect(unmatchedLines.map((l) => l.index)).toEqual([2]);
  });

  it('sin líneas ni pagos', () => {
    expect(matchTransfers([], [line(0)])).toEqual({ results: [], unmatchedLines: [line(0)] });
    expect(matchTransfers([pay('a')], []).results[0].kind).toBe('none');
  });
});
