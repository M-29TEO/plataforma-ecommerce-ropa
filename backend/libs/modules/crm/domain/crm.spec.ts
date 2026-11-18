import { assertPinInEcuador, isInEcuador, locationFieldsChanged, locationStatus, normalizeAddressFields } from './address';
import { buildGeocodeAttempts, GeocodeCandidate, pickCandidate } from './geocoding';
import {
  earnPoints,
  multiplierHundredths,
  nextTier,
  promotedTier,
  redemptionValueCents,
  resolveTier,
  reversalPoints,
  validateTier,
} from './loyalty';
import { canTransitionReferral, generateReferralCode, normalizeReferralCode, REFERRAL_CODE_LENGTH } from './referral';
import { evaluateWishlistItem, WishlistState } from './wishlist';

const ADDRESS = {
  recipientName: '  Ana   Pérez ',
  recipientPhone: '099 123-4567',
  province: 'Pichincha',
  city: 'Quito',
  mainStreet: 'Av. Amazonas',
  crossStreet: 'Naciones Unidas',
  houseNumber: 'N34-120',
  reference: '',
};

describe('direcciones', () => {
  it('normaliza espacios, teléfono y opcionales vacíos', () => {
    const a = normalizeAddressFields(ADDRESS);
    expect(a).toMatchObject({ recipientName: 'Ana Pérez', recipientPhone: '0991234567', reference: null, label: null, parish: null });
  });

  it('exige los campos obligatorios y un teléfono válido', () => {
    expect(() => normalizeAddressFields({ ...ADDRESS, mainStreet: ' ' })).toThrow(/mainStreet/);
    expect(() => normalizeAddressFields({ ...ADDRESS, province: undefined })).toThrow(/province/);
    expect(() => normalizeAddressFields({ ...ADDRESS, recipientPhone: 'llámame' })).toThrow(/teléfono/);
  });

  it('acepta pines en el continente y en Galápagos, y rechaza los de fuera', () => {
    expect(isInEcuador({ lat: -0.1765, lng: -78.48 })).toBe(true); // Quito
    expect(isInEcuador({ lat: -2.19, lng: -79.88 })).toBe(true); // Guayaquil
    expect(isInEcuador({ lat: -0.74, lng: -90.31 })).toBe(true); // Puerto Ayora
    expect(isInEcuador({ lat: 4.71, lng: -74.07 })).toBe(false); // Bogotá
    expect(isInEcuador({ lat: -78.48, lng: -0.1765 })).toBe(false); // lat/lng invertidos
    expect(() => assertPinInEcuador({ lat: -12.04, lng: -77.04 })).toThrow(/fuera de Ecuador/);
    expect(assertPinInEcuador({ lat: -0.17654321, lng: -78.481234567 })).toEqual({ lat: -0.176543, lng: -78.481235 });
  });

  it('indica si falta el pin o conviene confirmarlo', () => {
    expect(locationStatus({ location: null, geocodeAccuracy: null })).toEqual({ needsPin: true, pinRecommended: true });
    expect(locationStatus({ location: { lat: 0, lng: 0 }, geocodeAccuracy: 'street' })).toEqual({ needsPin: false, pinRecommended: true });
    expect(locationStatus({ location: { lat: 0, lng: 0 }, geocodeAccuracy: 'user_pin' })).toEqual({ needsPin: false, pinRecommended: false });
  });

  it('detecta cambios que invalidan la ubicación (no la referencia ni el teléfono)', () => {
    const a = normalizeAddressFields(ADDRESS);
    expect(locationFieldsChanged(a, { ...a, reference: 'Edificio azul', recipientPhone: '0987654321' })).toBe(false);
    expect(locationFieldsChanged(a, { ...a, houseNumber: 'N35-10' })).toBe(true);
  });
});

describe('geocodificación', () => {
  const query = normalizeAddressFields({ ...ADDRESS, neighborhood: 'Iñaquito' });

  it('arma la cascada: calle con número, calle, barrio', () => {
    const attempts = buildGeocodeAttempts(query);
    expect(attempts.map((a) => a.accuracy)).toEqual(['rooftop', 'street', 'approximate']);
    expect(attempts[0]).toMatchObject({ type: 'structured', street: 'N34-120 Av. Amazonas', city: 'Quito', state: 'Pichincha' });
    expect(attempts[2]).toMatchObject({ type: 'free', q: 'Iñaquito, Quito, Pichincha, Ecuador' });
    expect(buildGeocodeAttempts({ ...query, houseNumber: null, neighborhood: null, parish: null })).toHaveLength(1);
  });

  const candidate = (over: Partial<GeocodeCandidate>): GeocodeCandidate => ({
    lat: -0.1765,
    lng: -78.48,
    kind: 'street',
    displayName: 'Avenida Amazonas, Iñaquito, Quito, Pichincha, Ecuador',
    city: 'Quito',
    province: 'Pichincha',
    neighborhood: 'Iñaquito',
    ...over,
  });

  it('descarta homónimos de otra ciudad y puntos fuera de Ecuador', () => {
    const [first] = buildGeocodeAttempts(query);
    const otherCity = candidate({ city: 'Cuenca', displayName: 'Avenida Amazonas, Cuenca, Azuay, Ecuador' });
    const abroad = candidate({ lat: 4.7, lng: -74.07 });
    const good = candidate({ kind: 'house' });
    expect(pickCandidate([otherCity, abroad, good], query, first)).toMatchObject({ accuracy: 'rooftop' });
    expect(pickCandidate([otherCity, abroad], query, first)).toBeNull();
  });

  it('acepta la ciudad en el nombre completo (Nominatim reporta la parroquia como ciudad) y sin tildes', () => {
    const [, second] = buildGeocodeAttempts(query);
    const parish = candidate({ city: 'Cumbayá', displayName: 'Calle X, Cumbayá, QUITO, Pichincha, Ecuador' });
    expect(pickCandidate([parish], { city: 'quito' }, second)).toMatchObject({ accuracy: 'street' });
  });

  it('la precisión nunca supera lo que es el resultado', () => {
    const [first] = buildGeocodeAttempts(query);
    expect(pickCandidate([candidate({ kind: 'street' })], query, first)?.accuracy).toBe('street');
    expect(pickCandidate([candidate({ kind: 'area' })], query, first)?.accuracy).toBe('approximate');
  });
});

describe('wishlist', () => {
  const rules = { minDropBp: 500, cooldownMs: 24 * 3600_000 };
  const at = new Date('2026-10-01T15:00:00Z');
  const state = (over: Partial<WishlistState> = {}): WishlistState => ({
    notifyBackInStock: true,
    notifyPriceDrop: true,
    lastKnownPrice: '40.00',
    lastKnownInStock: true,
    lastAlertedAt: null,
    ...over,
  });

  it('la primera observación solo guarda el estado', () => {
    const r = evaluateWishlistItem(state({ lastKnownPrice: null, lastKnownInStock: null }), { price: '40.00', inStock: false }, rules, at);
    expect(r).toEqual({ alerts: [], next: { lastKnownPrice: '40.00', lastKnownInStock: false, lastAlertedAt: null } });
  });

  it('avisa la reposición (agotado → disponible)', () => {
    const r = evaluateWishlistItem(state({ lastKnownInStock: false }), { price: '40.00', inStock: true }, rules, at);
    expect(r.alerts).toEqual(['back_in_stock']);
    expect(r.next).toEqual({ lastKnownPrice: '40.00', lastKnownInStock: true, lastAlertedAt: at });
  });

  it('avisa la baja de precio desde el umbral (5 %) y solo con stock', () => {
    expect(evaluateWishlistItem(state(), { price: '38.00', inStock: true }, rules, at).alerts).toEqual(['price_drop']);
    expect(evaluateWishlistItem(state(), { price: '38.01', inStock: true }, rules, at).alerts).toEqual([]);
    expect(evaluateWishlistItem(state(), { price: '30.00', inStock: false }, rules, at).alerts).toEqual([]);
  });

  it('respeta las preferencias del cliente', () => {
    const r = evaluateWishlistItem(state({ lastKnownInStock: false, notifyBackInStock: false, notifyPriceDrop: false }), { price: '20.00', inStock: true }, rules, at);
    expect(r.alerts).toEqual([]);
    expect(r.next.lastKnownInStock).toBe(true);
  });

  it('en el enfriamiento no avisa y conserva la referencia para avisar después', () => {
    const recent = new Date(at.getTime() - 3600_000);
    const r = evaluateWishlistItem(state({ lastAlertedAt: recent }), { price: '30.00', inStock: true }, rules, at);
    expect(r).toEqual({ alerts: [], next: { lastKnownPrice: '40.00', lastKnownInStock: true, lastAlertedAt: recent } });
    const later = new Date(at.getTime() + 24 * 3600_000);
    expect(evaluateWishlistItem({ ...state(), ...r.next }, { price: '30.00', inStock: true }, rules, later).alerts).toEqual(['price_drop']);
  });

  it('una subida de precio mueve la referencia', () => {
    const up = evaluateWishlistItem(state(), { price: '50.00', inStock: true }, rules, at);
    expect(up.next.lastKnownPrice).toBe('50.00');
    expect(evaluateWishlistItem({ ...state(), ...up.next }, { price: '45.00', inStock: true }, rules, at).alerts).toEqual(['price_drop']);
  });
});

describe('puntos y niveles', () => {
  const tiers = [
    { id: 'b', minPoints: 0, multiplier: '1.00' },
    { id: 'p', minPoints: 1000, multiplier: '1.25' },
    { id: 'o', minPoints: 3000, multiplier: '1.50' },
  ];

  it('calcula puntos en enteros, hacia abajo', () => {
    expect(earnPoints(4599, 1, '1.00')).toBe(45);
    expect(earnPoints(4599, 1, '1.25')).toBe(57); // 57.4875
    expect(earnPoints(10_000, 2, '1.50')).toBe(300);
    expect(earnPoints(0, 1, '1.50')).toBe(0);
    expect(multiplierHundredths('1.5')).toBe(150);
    expect(() => multiplierHundredths('1.255')).toThrow();
  });

  it('revierte en proporción al reembolso, hacia arriba y sin pasarse', () => {
    expect(reversalPoints(57, 0, 4599, 2300)).toBe(29); // 28.5 → 29
    expect(reversalPoints(57, 29, 4599, 2299)).toBe(28); // lo que queda
    expect(reversalPoints(57, 29, 4599, 4599)).toBe(28);
    expect(reversalPoints(57, 57, 4599, 100)).toBe(0);
    expect(reversalPoints(57, 0, 4599, 0)).toBe(0);
  });

  it('resuelve el nivel por puntos históricos y el siguiente', () => {
    expect(resolveTier(tiers, 0)?.id).toBe('b');
    expect(resolveTier(tiers, 2999)?.id).toBe('p');
    expect(resolveTier(tiers, 3000)?.id).toBe('o');
    expect(resolveTier([], 5000)).toBeNull();
    expect(nextTier(tiers, 1500)?.id).toBe('o');
    expect(nextTier(tiers, 9999)).toBeNull();
  });

  it('el nivel no baja', () => {
    expect(promotedTier(tiers, 'o', 1200)?.id).toBe('o');
    expect(promotedTier(tiers, 'b', 1200)?.id).toBe('p');
    expect(promotedTier(tiers, null, 10)?.id).toBe('b');
  });

  it('valida niveles', () => {
    expect(validateTier({ name: ' Oro ', minPoints: 3000, multiplier: '1.5' })).toEqual({ name: 'Oro', minPoints: 3000, multiplier: '1.50', benefits: {} });
    expect(() => validateTier({ name: 'X', minPoints: 0, multiplier: '1' })).toThrow(/name/);
    expect(() => validateTier({ name: 'Oro', minPoints: -1, multiplier: '1' })).toThrow(/minPoints/);
    expect(() => validateTier({ name: 'Oro', minPoints: 1, multiplier: '0.50' })).toThrow(/multiplier/);
    expect(validateTier({ multiplier: '2' }, true)).toEqual({ multiplier: '2.00' });
  });

  it('valor del canje', () => {
    expect(redemptionValueCents(500, { pointsPerUsd: 100, minPoints: 500 })).toBe(500);
    expect(redemptionValueCents(150, { pointsPerUsd: 100, minPoints: 100 })).toBe(150);
  });
});

describe('referidos', () => {
  it('genera códigos sin caracteres ambiguos y los normaliza', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateReferralCode();
      expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
      expect(code).not.toMatch(/[01OILU]/);
      expect(normalizeReferralCode(code.toLowerCase())).toBe(code);
    }
    expect(normalizeReferralCode(' abcd-2345 ')).toBe('ABCD2345');
    expect(normalizeReferralCode('ABCD0345')).toBeNull();
    expect(normalizeReferralCode('ABC')).toBeNull();
  });

  it('sigue el ciclo registrado → calificado → recompensado', () => {
    expect(canTransitionReferral('registered', 'qualified')).toBe(true);
    expect(canTransitionReferral('qualified', 'rewarded')).toBe(true);
    expect(canTransitionReferral('registered', 'rewarded')).toBe(false);
    expect(canTransitionReferral('rewarded', 'rejected')).toBe(false);
  });
});
