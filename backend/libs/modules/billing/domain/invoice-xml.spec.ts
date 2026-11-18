import { invoiceData } from './invoice.fixture';
import { buildInvoiceXml } from './invoice-xml';

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

describe('XML de factura 2.1.0', () => {
  const data = invoiceData();
  const xml = buildInvoiceXml(data);

  test('raíz factura con id="comprobante" y version 2.1.0, en forma canónica (sin declaración ni <a/>)', () => {
    expect(xml.startsWith('<factura id="comprobante" version="2.1.0"><infoTributaria>')).toBe(true);
    expect(xml.endsWith('</factura>')).toBe(true);
    expect(xml).not.toMatch(/\/>/);
    expect(xml).not.toMatch(/>\s+</);
  });

  test('infoTributaria en el orden de la ficha técnica', () => {
    const info = /<infoTributaria>(.*)<\/infoTributaria>/.exec(xml)![1];
    const names = [...info.matchAll(/<([a-zA-Z]+)>/g)].map((m) => m[1]);
    expect(names).toEqual(['ambiente', 'tipoEmision', 'razonSocial', 'nombreComercial', 'ruc', 'claveAcceso', 'codDoc', 'estab', 'ptoEmi', 'secuencial', 'dirMatriz']);
    expect(tag(xml, 'claveAcceso')).toBe(data.accessKey);
    expect(tag(xml, 'secuencial')).toBe('000000001');
  });

  test('infoFactura: fecha dd/mm/aaaa, comprador, totales, IVA agrupado y pagos', () => {
    expect(tag(xml, 'fechaEmision')).toBe('30/09/2026');
    expect(tag(xml, 'obligadoContabilidad')).toBe('SI');
    expect(tag(xml, 'tipoIdentificacionComprador')).toBe('05');
    expect(tag(xml, 'identificacionComprador')).toBe('1710034065');
    expect(tag(xml, 'totalSinImpuestos')).toBe('71.00');
    expect(tag(xml, 'totalDescuento')).toBe('2.00');
    expect(tag(xml, 'importeTotal')).toBe('76.70');
    expect(tag(xml, 'moneda')).toBe('DOLAR');
    expect(xml).toContain(
      '<totalConImpuestos><totalImpuesto><codigo>2</codigo><codigoPorcentaje>0</codigoPorcentaje><baseImponible>33.00</baseImponible><valor>0.00</valor></totalImpuesto>' +
        '<totalImpuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje><baseImponible>38.00</baseImponible><valor>5.70</valor></totalImpuesto></totalConImpuestos>',
    );
    expect(xml).toContain('<pagos><pago><formaPago>19</formaPago><total>76.70</total></pago></pagos>');
  });

  test('detalle con impuesto por línea', () => {
    expect(xml).toContain(
      '<detalle><codigoPrincipal>BLU-LIN-BLA-M</codigoPrincipal><descripcion>Blusa lino - Blanco - Talla M</descripcion><cantidad>2.00</cantidad>' +
        '<precioUnitario>20.00</precioUnitario><descuento>2.00</descuento><precioTotalSinImpuesto>38.00</precioTotalSinImpuesto>' +
        '<impuestos><impuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje><tarifa>15</tarifa><baseImponible>38.00</baseImponible><valor>5.70</valor></impuesto></impuestos></detalle>',
    );
  });

  test('consumidor final y escapes de texto y atributos', () => {
    const cf = buildInvoiceXml(invoiceData({ billing: {}, customer: { name: 'A & B <Moda>', email: 'x@example.test' } }));
    expect(tag(cf, 'tipoIdentificacionComprador')).toBe('07');
    expect(tag(cf, 'identificacionComprador')).toBe('9999999999999');
    expect(tag(cf, 'razonSocialComprador')).toBe('CONSUMIDOR FINAL');
    expect(cf).not.toContain('<direccionComprador>');

    const escaped = buildInvoiceXml(invoiceData({ billing: { idType: '05', idNumber: '1710034065', name: 'Pérez & Hijos <S.A.>' } }));
    expect(escaped).toContain('<razonSocialComprador>Pérez &amp; Hijos &lt;S.A.&gt;</razonSocialComprador>');
    expect(escaped).toContain('<campoAdicional nombre="Pedido">#100045</campoAdicional>');
  });
});
