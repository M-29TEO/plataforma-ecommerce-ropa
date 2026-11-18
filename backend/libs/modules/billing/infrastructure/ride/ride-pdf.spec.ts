import { creditNoteData, invoiceData } from '../../domain/invoice.fixture';
import { CODE128_PATTERNS, code128Bars, code128Values } from './code128';
import { renderRidePdf, totalRows } from './ride-pdf';

describe('Code 128', () => {
  test('tabla de patrones: 107 símbolos distintos de 11 módulos (parada: 13) con barras de módulos pares', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.forEach((p, v) => {
      const widths = [...p].map(Number);
      expect(widths.reduce((a, b) => a + b, 0)).toBe(v === 106 ? 13 : 11);
      // Paridad de Code 128: las barras (posiciones pares) suman un número par de módulos.
      expect(widths.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) % 2).toBe(0);
    });
  });

  test('subconjunto C con dígito de control módulo 103', () => {
    // Start C (105) + 12 + 34×2 = 185 → 185 mod 103 = 82
    expect(code128Values('1234')).toEqual([105, 12, 34, 82, 106]);
  });

  test('cantidad impar de dígitos: el último va en el subconjunto B', () => {
    // "3" en B = 0x33 − 32 = 19; control: 105 + 12 + 100×2 + 19×3 = 374 → 374 mod 103 = 65
    expect(code128Values('123')).toEqual([105, 12, 100, 19, 65, 106]);
  });

  test('una clave de 49 dígitos: inicio + 24 pares + CODE B + 1 dígito + control + parada', () => {
    const key = invoiceData().accessKey;
    expect(code128Values(key)).toHaveLength(1 + 24 + 2 + 1 + 1);
    expect(code128Bars(key).modules).toBe(11 * 28 + 13);
  });
});

describe('RIDE en PDF', () => {
  const ride = (overrides = {}) => ({
    ...invoiceData(overrides),
    authorizationNumber: invoiceData().accessKey,
    authorizedAt: new Date('2026-09-30T15:21:04Z'),
  });

  test('PDF válido de una página con número, autorización y comprador', () => {
    const pdf = renderRidePdf(ride());
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Count 1');
    expect(text).toContain('(No. 001-001-000000001)');
    expect(text).toContain(`(${ride().accessKey})`);
    expect(text).toContain('(30/09/2026 10:21:04)');
    expect(text).toContain('(Ana P\xe9rez)'); // latin1 / WinAnsi
    expect(text).toContain('(Ambiente de PRUEBAS: comprobante sin validez tributaria.)');
  });

  test('la tabla xref apunta al inicio de cada objeto', () => {
    const pdf = renderRidePdf(ride()).toString('latin1');
    const startxref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(pdf.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });

  test('muchas líneas continúan en páginas nuevas', () => {
    const item = { sku: 'CAM-001', productName: 'Camiseta básica algodón orgánico', colorName: 'Negro', sizeCode: 'M', quantity: 1, unitPrice: '10.00', discount: '0.00', taxCode: '4', taxAmount: '1.50' };
    const items = Array.from({ length: 60 }, () => item);
    const pdf = renderRidePdf(ride({ items, shippingTotal: '0.00', total: '690.00' })).toString('latin1');
    expect(Number(/\/Count (\d+)/.exec(pdf)![1])).toBeGreaterThan(1);
    expect(pdf).toContain('\\(continuaci\xf3n\\)'); // paréntesis escapados en el string PDF
  });

  test('totales por tarifa', () => {
    const d = ride();
    expect(totalRows(d)).toEqual([
      ['SUBTOTAL 15%', '38.00', false],
      ['SUBTOTAL 0%', '33.00', false],
      ['SUBTOTAL NO OBJETO DE IVA', '0.00', false],
      ['SUBTOTAL EXENTO DE IVA', '0.00', false],
      ['SUBTOTAL SIN IMPUESTOS', '71.00', false],
      ['TOTAL DESCUENTO', '2.00', false],
      ['IVA 15%', '5.70', false],
      ['PROPINA', '0.00', false],
      ['VALOR TOTAL', '76.70', true],
    ]);
  });

  test('nota de crédito: título, comprobante modificado y razón, sin formas de pago', () => {
    const data = creditNoteData();
    const pdf = renderRidePdf({ ...data, docType: '04', authorizationNumber: data.accessKey, authorizedAt: new Date('2026-10-05T15:00:00Z') }).toString('latin1');
    expect(pdf).toContain('(NOTA DE CRÉDITO)');
    expect(pdf).toContain('(FACTURA 001-001-000000001)');
    expect(pdf).toContain('(30/09/2026)');
    expect(pdf).toContain('(Devolución RMA-100045-1: Talla pequeña)');
    expect(pdf).not.toContain('(Forma de pago)');
    expect(pdf).toContain('/Title (Nota de crédito 001-001-000000001)');
  });
});
