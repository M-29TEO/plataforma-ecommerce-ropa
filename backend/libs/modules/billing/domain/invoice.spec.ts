import { assertValidBuyerId, isValidCedula, isValidRuc } from './buyer-id';
import { BuyerIdRequiredError, InvalidBuyerIdError, InvalidInvoiceError } from './errors';
import { assertConsumerFinalAllowed, draftInvoice, taxTotals } from './invoice';
import { orderSource } from './invoice.fixture';

describe('pedido → factura', () => {
  test('líneas con IVA, envío como línea al 0 % y totales', () => {
    const d = draftInvoice(orderSource());
    expect(d.lines).toHaveLength(3);
    expect(d.lines[0]).toMatchObject({
      mainCode: 'BLU-LIN-BLA-M',
      description: 'Blusa lino - Blanco - Talla M',
      quantity: 2,
      unitPrice: '20.00',
      discount: '2.00',
      taxCode: '2',
      taxRateCode: '4',
      taxRate: '15.00',
      taxBase: '38.00',
      taxAmount: '5.70',
      lineTotal: '43.70',
    });
    expect(d.lines[2]).toMatchObject({ mainCode: 'ENVIO', description: 'Servicio de envío', taxRateCode: '0', taxBase: '3.00', taxAmount: '0.00' });
    expect(d).toMatchObject({ subtotal0: '33.00', subtotalTaxed: '38.00', discountTotal: '2.00', taxTotal: '5.70', total: '76.70' });
    expect(d.paymentForms).toEqual([{ code: '19', total: '76.70' }]);
    expect(d.buyer).toEqual({
      idType: '05',
      idNumber: '1710034065',
      name: 'Ana Pérez',
      email: 'ana@example.test',
      address: 'Av. Amazonas N34-45 y Av. República, Quito',
      phone: '0991234567',
    });
    expect(d.additionalInfo.map((f) => f.name)).toEqual(['Email', 'Teléfono', 'Pedido', 'Dirección de entrega']);
  });

  test('sin identificación: CONSUMIDOR FINAL 07 / 9999999999999, con el email del cliente', () => {
    const d = draftInvoice(orderSource({ billing: { name: 'Ana Pérez', email: 'ana@example.test' } }));
    expect(d.buyer).toMatchObject({ idType: '07', idNumber: '9999999999999', name: 'CONSUMIDOR FINAL', email: 'ana@example.test' });
  });

  test('la gift card es una forma de pago (18) y el importe total incluye lo pagado con ella', () => {
    const d = draftInvoice(orderSource({ giftCardTotal: '10.00', total: '66.70' }));
    expect(d.total).toBe('76.70');
    expect(d.paymentForms).toEqual([
      { code: '19', total: '66.70' },
      { code: '18', total: '10.00' },
    ]);
  });

  test('contra entrega = sin utilización del sistema financiero (01); pagado todo con gift card = solo 18', () => {
    expect(draftInvoice(orderSource({ paymentMethod: 'cod' })).paymentForms).toEqual([{ code: '01', total: '76.70' }]);
    expect(draftInvoice(orderSource({ paymentMethod: 'gift_card', giftCardTotal: '76.70', total: '0.00' })).paymentForms).toEqual([
      { code: '18', total: '76.70' },
    ]);
  });

  test('sin envío no hay línea ENVIO', () => {
    const d = draftInvoice(orderSource({ shippingTotal: '0.00', total: '73.70' }));
    expect(d.lines.map((l) => l.mainCode)).toEqual(['BLU-LIN-BLA-M', 'BOL-CUE-NEG']);
  });

  test('rechaza un pedido cuyo total o IVA no cuadra', () => {
    expect(() => draftInvoice(orderSource({ total: '76.71' }))).toThrow(InvalidInvoiceError);
    const items = orderSource().items.map((i, n) => (n === 0 ? { ...i, taxAmount: '5.71' } : i));
    expect(() => draftInvoice(orderSource({ items }))).toThrow(InvalidInvoiceError);
    expect(() => draftInvoice(orderSource({ items: [] }))).toThrow(InvalidInvoiceError);
  });

  test('totalConImpuestos agrupa por código de porcentaje', () => {
    expect(taxTotals(draftInvoice(orderSource()).lines)).toEqual([
      { taxCode: '2', rateCode: '0', rate: '0.00', base: '33.00', amount: '0.00' },
      { taxCode: '2', rateCode: '4', rate: '15.00', base: '38.00', amount: '5.70' },
    ]);
  });
});

describe('consumidor final', () => {
  test('hasta el límite se permite; por encima exige identificación; 0 = sin límite', () => {
    expect(() => assertConsumerFinalAllowed(50_00, 50_00)).not.toThrow();
    expect(() => assertConsumerFinalAllowed(50_01, 50_00)).toThrow(BuyerIdRequiredError);
    expect(() => assertConsumerFinalAllowed(1_000_00, 0)).not.toThrow();
  });
});

describe('identificación del comprador', () => {
  test('cédula: módulo 10, provincia y tercer dígito', () => {
    expect(isValidCedula('1710034065')).toBe(true);
    expect(isValidCedula('1712345678')).toBe(false); // dígito verificador incorrecto
    expect(isValidCedula('2510034065')).toBe(false); // provincia 25 no existe
    expect(isValidCedula('1760013210')).toBe(false); // tercer dígito 6: no es persona natural
    expect(isValidCedula('171003406')).toBe(false);
  });

  test('RUC: persona natural = cédula + 001; sociedades por provincia y tipo', () => {
    expect(isValidRuc('1710034065001')).toBe(true);
    expect(isValidRuc('1790000000001')).toBe(true); // sociedad privada
    expect(isValidRuc('1760013210001')).toBe(true); // sector público
    expect(isValidRuc('1710034065000')).toBe(false);
    expect(isValidRuc('1712345678001')).toBe(false);
    expect(isValidRuc('1770000000001')).toBe(false);
  });

  test('assertValidBuyerId por tipo', () => {
    expect(() => assertValidBuyerId('05', '1710034065')).not.toThrow();
    expect(() => assertValidBuyerId('06', 'AB123456')).not.toThrow();
    expect(() => assertValidBuyerId('07', '9999999999999')).not.toThrow();
    expect(() => assertValidBuyerId('05', '1712345678')).toThrow(InvalidBuyerIdError);
    expect(() => assertValidBuyerId('07', '1710034065')).toThrow(InvalidBuyerIdError);
    expect(() => assertValidBuyerId('99', '1')).toThrow(InvalidBuyerIdError);
  });
});
