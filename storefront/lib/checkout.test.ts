import { describe, expect, it } from 'vitest';
import { addressReady, deliveryPrice, emptyAddress, expectedTotal, idError, isValidCedula, isValidRuc, orderAddress, quoteAddress } from './checkout';
import type { DeliveryOption } from './commerce-types';

describe('checkout: reglas del formulario', () => {
  it('cédula ecuatoriana con dígito verificador', () => {
    expect(isValidCedula('1710034065')).toBe(true);
    expect(isValidCedula('1710034066')).toBe(false);
    expect(isValidCedula('2510034065')).toBe(false); // provincia 25 no existe
    expect(isValidCedula('171003406')).toBe(false);
    expect(idError('05', '1710034065')).toBeNull();
    expect(idError('06', 'AB12')).toMatch(/pasaporte/);
  });

  it('RUC de persona natural = cédula + 001', () => {
    expect(isValidRuc('1710034065001')).toBe(true);
    expect(isValidRuc('1710034065002')).toBe(false);
  });

  it('la cotización no lleva barrio (el API rechaza campos extra); el pedido sí', () => {
    const a = { ...emptyAddress(), mainStreet: ' Av. Amazonas ', neighborhood: 'La Carolina', lat: -0.18, lng: -78.48 };
    expect(quoteAddress(a)).not.toHaveProperty('neighborhood', 'La Carolina');
    expect(quoteAddress(a)).toMatchObject({ mainStreet: 'Av. Amazonas', city: 'Quito', province: 'Pichincha', lat: -0.18 });
    expect(orderAddress(a).neighborhood).toBe('La Carolina');
    expect(quoteAddress(a).secondaryStreet).toBeUndefined();
  });

  it('dirección lista solo con calle, ciudad y pin', () => {
    expect(addressReady({ ...emptyAddress(), mainStreet: 'Av. 6 de Diciembre' })).toBe(false);
    expect(addressReady({ ...emptyAddress(), mainStreet: 'Av. 6 de Diciembre', lat: -0.2, lng: -78.5 })).toBe(true);
  });

  it('precio del envío: con franja, el de la franja', () => {
    const rider: DeliveryOption = {
      quoteId: 'q',
      type: 'rider',
      price: '3.00',
      label: 'Motorizado',
      source: 'own_fleet',
      etaHours: 2,
      slots: [{ slotId: 's1', date: '2026-10-06', startsAt: '', endsAt: '', available: 3, surcharge: '1.50', price: '4.50' }],
    };
    expect(deliveryPrice(rider, null)).toBeNull();
    expect(deliveryPrice(rider, 's1')).toBe('4.50');
    expect(deliveryPrice({ ...rider, type: 'courier', slots: undefined, price: '6.80' }, null)).toBe('6.80');
  });

  it('total esperado sin errores de coma flotante; envío gratis no suma', () => {
    expect(expectedTotal('49.90', '4.50', false)).toBe('54.40');
    expect(expectedTotal('0.10', '0.20', false)).toBe('0.30');
    expect(expectedTotal('60.00', '4.50', true)).toBe('60.00');
    expect(expectedTotal('60.00', null, false)).toBeNull();
  });
});
