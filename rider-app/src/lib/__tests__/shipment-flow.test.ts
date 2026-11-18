import { changeDue, deliveryErrorMessage, validateDraft } from '../delivery';
import { ApiError } from '../api-client';
import { boundsFor, haversineMeters } from '../geo';
import { geoUri, osmDirectionsUrl } from '../navigation';
import { actionsFor, isValidOtp, navigationTarget, pinsFor } from '../shipment-flow';
import { inkLength, isSignatureComplete, strokeToPath } from '../signature';
import type { RiderShipment } from '../types';

const shipment = (over: Partial<RiderShipment> = {}): RiderShipment => ({
  id: 's1',
  orderId: 'o1',
  orderNumber: 'MOD-1001',
  status: 'accepted',
  pickup: { name: 'Bodega Norte', location: { lat: -0.17, lng: -78.48 } },
  destination: { label: 'Av. Amazonas, Quito', location: { lat: -0.19, lng: -78.49 }, recipientName: 'Ana', phone: '+593990000000' },
  slot: null,
  codAmount: '0.00',
  distanceM: 3200,
  estimatedFee: '3.50',
  requiresOtp: true,
  attempts: 0,
  deliveredAt: null,
  ...over,
});

describe('flujo del envío', () => {
  it('ofrece el siguiente paso en cada estado', () => {
    expect(actionsFor('accepted').map((a) => a.kind === 'status' && a.to)).toEqual(['picked_up']);
    expect(actionsFor('picked_up').map((a) => a.kind === 'status' && a.to)).toEqual(['in_transit']);
    expect(actionsFor('in_transit').map((a) => a.kind)).toEqual(['status', 'deliver', 'fail']);
    expect(actionsFor('arriving').map((a) => a.kind)).toEqual(['deliver', 'fail']);
    expect(actionsFor('failed_attempt').map((a) => a.kind === 'status' && a.to)).toEqual(['in_transit']);
    expect(actionsFor('delivered')).toEqual([]);
    expect(actionsFor('cancelled')).toEqual([]);
  });

  it('navega a la bodega antes del retiro y al cliente después', () => {
    expect(navigationTarget(shipment())?.label).toBe('Bodega Norte');
    expect(navigationTarget(shipment({ status: 'in_transit' }))?.label).toBe('Av. Amazonas, Quito');
    expect(navigationTarget(shipment({ status: 'in_transit', destination: { label: 'x', location: null } }))).toBeNull();
  });

  it('pone un pin por envío según la etapa', () => {
    const pins = pinsFor([shipment(), shipment({ id: 's2', status: 'arriving' })]);
    expect(pins.map((p) => [p.id, p.kind])).toEqual([
      ['p-s1', 'pickup'],
      ['d-s2', 'dropoff'],
    ]);
  });

  it('valida el código OTP de 4 dígitos', () => {
    expect(isValidOtp('0420')).toBe(true);
    expect(isValidOtp('420')).toBe(false);
    expect(isValidOtp('42a0')).toBe(false);
  });
});

describe('prueba de entrega', () => {
  const base = { photoUri: 'file:///f.jpg', signatureComplete: true, receiverName: 'Ana', otp: '1234', requiresOtp: true, codAmount: '0.00', codMethod: 'cash' as const, codConfirmed: false };

  it('exige foto, firma, nombre, OTP y confirmar el cobro', () => {
    expect(validateDraft(base)).toEqual({});
    expect(Object.keys(validateDraft({ ...base, photoUri: null, signatureComplete: false, receiverName: ' ', otp: '12' })).sort()).toEqual(['otp', 'photo', 'receiverName', 'signature']);
    expect(validateDraft({ ...base, requiresOtp: false, otp: '' })).toEqual({});
    expect(validateDraft({ ...base, codAmount: '25.00' }).cod).toBeDefined();
    expect(validateDraft({ ...base, codAmount: '25.00', codConfirmed: true })).toEqual({});
  });

  it('calcula el vuelto', () => {
    expect(changeDue('17.25', '20')).toBe('2.75');
    expect(changeDue('17.25', '17.25')).toBe('0.00');
    expect(changeDue('17.25', '10')).toBeNull();
    expect(changeDue('17.25', 'veinte')).toBeNull();
  });

  it('traduce los rechazos de la API', () => {
    expect(deliveryErrorMessage(new ApiError(422, 'OTP_INVALID', 'x', { attemptsLeft: 2 }))).toContain('Te quedan 2 intentos');
    expect(deliveryErrorMessage(new ApiError(423, 'OTP_LOCKED', 'x'))).toContain('15 minutos');
    expect(deliveryErrorMessage(new ApiError(422, 'DELIVERY_TOO_FAR', 'Estás a 900 m'))).toBe('Estás a 900 m');
  });
});

describe('firma', () => {
  it('arma el path SVG y mide la tinta', () => {
    expect(strokeToPath([{ x: 1, y: 2 }])).toBe('M1,2 l0.1,0.1');
    expect(strokeToPath([{ x: 0, y: 0 }, { x: 3, y: 4 }])).toBe('M0,0 L3,4');
    expect(inkLength([[{ x: 0, y: 0 }, { x: 3, y: 4 }]])).toBe(5);
  });

  it('un punto o una raya corta no es firma', () => {
    expect(isSignatureComplete([[{ x: 0, y: 0 }]])).toBe(false);
    expect(isSignatureComplete([[{ x: 0, y: 0 }, { x: 50, y: 0 }], [{ x: 0, y: 10 }, { x: 40, y: 10 }]])).toBe(true);
  });
});

describe('geografía y navegación', () => {
  it('encuadra puntos con un mínimo de amplitud', () => {
    expect(boundsFor([])).toBeNull();
    const [w, s, e, n] = boundsFor([{ lat: -0.18, lng: -78.47 }])!;
    expect(e - w).toBeCloseTo(0.003);
    expect(n - s).toBeCloseTo(0.003);
    expect(boundsFor([{ lat: -0.1, lng: -78.5 }, { lat: -0.2, lng: -78.4 }])).toEqual([-78.5, -0.2, -78.4, -0.1]);
  });

  it('mide distancias', () => {
    expect(Math.round(haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 0.01 }))).toBe(1112);
  });

  it('arma el intent geo: y la ruta de OpenStreetMap', () => {
    expect(geoUri({ lat: -0.19, lng: -78.49 }, 'Casa (azul)')).toBe(`geo:-0.19,-78.49?q=${encodeURIComponent('-0.19,-78.49(Casa  azul)')}`);
    expect(osmDirectionsUrl({ lat: -0.19, lng: -78.49 }, { lat: -0.17, lng: -78.48 })).toBe(
      `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${encodeURIComponent('-0.17,-78.48;-0.19,-78.49')}`,
    );
  });
});
