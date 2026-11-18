import { parseAccessKey } from './access-key';
import { draftCreditNote } from './credit-note';
import { buildCreditNoteXml } from './credit-note-xml';
import { CreditNoteNotAllowedError, InvalidInvoiceError } from './errors';
import { creditNoteData, creditNoteSource, invoiceData } from './invoice.fixture';

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
const invoice = invoiceData();
const ref = { buyer: invoice.buyer, total: invoice.total, creditedBefore: '0.00' };

describe('draftCreditNote', () => {
  test('líneas, totales y motivo a partir de la devolución', () => {
    const d = draftCreditNote(creditNoteSource(), ref);
    expect(d.lines).toEqual([
      expect.objectContaining({ mainCode: 'BLU-LIN-BLA-M', quantity: 1, unitPrice: '20.00', discount: '1.00', taxRateCode: '4', taxRate: '15.00', taxBase: '19.00', taxAmount: '2.85', lineTotal: '21.85' }),
    ]);
    expect(d).toMatchObject({ subtotal0: '0.00', subtotalTaxed: '19.00', discountTotal: '1.00', taxTotal: '2.85', total: '21.85' });
    expect(d.reason).toBe('Devolución RMA-100045-1: Talla pequeña');
    expect(d.buyer).toEqual(invoice.buyer);
    expect(d.additionalInfo).toEqual([
      { name: 'Email', value: 'ana@example.test' },
      { name: 'Pedido', value: '#100045' },
      { name: 'Devolución', value: 'RMA-100045-1' },
    ]);
  });

  test('IVA 0 % va al subtotal 0 %', () => {
    const d = draftCreditNote(
      creditNoteSource({
        refundAmount: '30.00',
        lines: [{ sku: 'BOL-CUE-NEG', productName: 'Bolso cuero', colorName: null, sizeCode: null, quantity: 1, unitPrice: '30.00', discount: '0.00', taxCode: '0', taxBase: '30.00', taxAmount: '0.00', total: '30.00' }],
      }),
      ref,
    );
    expect(d).toMatchObject({ subtotal0: '30.00', subtotalTaxed: '0.00', taxTotal: '0.00', total: '30.00' });
  });

  test('el SRI no admite notas de crédito a consumidor final', () => {
    const cf = { ...ref, buyer: { ...ref.buyer, idType: '07', idNumber: '9999999999999', name: 'CONSUMIDOR FINAL' } };
    expect(() => draftCreditNote(creditNoteSource(), cf)).toThrow(CreditNoteNotAllowedError);
  });

  test('rechaza una línea cuyo IVA no corresponde a su base', () => {
    const src = creditNoteSource();
    src.lines[0] = { ...src.lines[0], taxAmount: '3.00', total: '22.00' };
    expect(() => draftCreditNote({ ...src, refundAmount: '22.00' }, ref)).toThrow(expect.objectContaining({ code: 'LINE_TAX_MISMATCH' }));
  });

  test('el total debe ser igual a lo reembolsado', () => {
    expect(() => draftCreditNote(creditNoteSource({ refundAmount: '20.00' }), ref)).toThrow(expect.objectContaining({ code: 'TOTAL_MISMATCH' }));
  });

  test('las notas de crédito de una factura no pueden superar su total', () => {
    expect(() => draftCreditNote(creditNoteSource(), { ...ref, creditedBefore: '60.00' })).toThrow(InvalidInvoiceError);
    expect(() => draftCreditNote(creditNoteSource(), { ...ref, creditedBefore: '54.85' })).not.toThrow();
  });
});

describe('XML de nota de crédito 1.1.0', () => {
  const data = creditNoteData();
  const xml = buildCreditNoteXml(data);

  test('raíz notaCredito con id="comprobante" y version 1.1.0, en forma canónica', () => {
    expect(xml.startsWith('<notaCredito id="comprobante" version="1.1.0"><infoTributaria>')).toBe(true);
    expect(xml.endsWith('</notaCredito>')).toBe(true);
    expect(xml).not.toMatch(/\/>/);
    expect(tag(xml, 'codDoc')).toBe('04');
    expect(parseAccessKey(tag(xml, 'claveAcceso')!)).toMatchObject({ docType: '04', sequential: 1 });
  });

  test('infoNotaCredito en el orden del esquema, con el documento modificado y el motivo', () => {
    const info = /<infoNotaCredito>(.*)<\/infoNotaCredito>/.exec(xml)![1];
    const names = [...info.replace(/<totalConImpuestos>.*<\/totalConImpuestos>/, '<totalConImpuestos>').matchAll(/<([a-zA-Z]+)>/g)].map((m) => m[1]);
    expect(names).toEqual([
      'fechaEmision',
      'dirEstablecimiento',
      'tipoIdentificacionComprador',
      'razonSocialComprador',
      'identificacionComprador',
      'obligadoContabilidad',
      'codDocModificado',
      'numDocModificado',
      'fechaEmisionDocSustento',
      'totalSinImpuestos',
      'valorModificacion',
      'moneda',
      'totalConImpuestos',
      'motivo',
    ]);
    expect(tag(xml, 'fechaEmision')).toBe('05/10/2026');
    expect(tag(xml, 'codDocModificado')).toBe('01');
    expect(tag(xml, 'numDocModificado')).toBe('001-001-000000001');
    expect(tag(xml, 'fechaEmisionDocSustento')).toBe('30/09/2026');
    expect(tag(xml, 'totalSinImpuestos')).toBe('19.00');
    expect(tag(xml, 'valorModificacion')).toBe('21.85');
    expect(tag(xml, 'motivo')).toBe('Devolución RMA-100045-1: Talla pequeña');
    expect(xml).toContain(
      '<totalConImpuestos><totalImpuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje><baseImponible>19.00</baseImponible><valor>2.85</valor></totalImpuesto></totalConImpuestos>',
    );
    expect(xml).not.toContain('<pagos>');
  });

  test('detalle con codigoInterno e impuesto por línea', () => {
    expect(xml).toContain(
      '<detalle><codigoInterno>BLU-LIN-BLA-M</codigoInterno><descripcion>Blusa lino - Blanco - Talla M</descripcion><cantidad>1.00</cantidad>' +
        '<precioUnitario>20.00</precioUnitario><descuento>1.00</descuento><precioTotalSinImpuesto>19.00</precioTotalSinImpuesto>' +
        '<impuestos><impuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje><tarifa>15</tarifa><baseImponible>19.00</baseImponible><valor>2.85</valor></impuesto></impuestos></detalle>',
    );
    expect(xml).toContain('<campoAdicional nombre="Devolución">RMA-100045-1</campoAdicional>');
  });
});
