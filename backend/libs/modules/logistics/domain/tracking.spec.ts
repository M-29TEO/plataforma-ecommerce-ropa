import { assertRecentPosition, assertShipmentTransition, fallbackEtaSeconds, isLive, orderStepsFor, ShipmentTransitionError, StalePositionError } from './tracking';

describe('Tracking del motorizado: reglas puras', () => {
  it('transiciones del envío: asignar, retirar, en camino, llegando, entregar', () => {
    expect(() => assertShipmentTransition('pending', 'assigned')).not.toThrow();
    expect(() => assertShipmentTransition('assigned', 'assigned')).not.toThrow(); // reasignar
    expect(() => assertShipmentTransition('assigned', 'picked_up')).not.toThrow();
    expect(() => assertShipmentTransition('picked_up', 'in_transit')).not.toThrow();
    expect(() => assertShipmentTransition('in_transit', 'delivered')).not.toThrow();
    expect(() => assertShipmentTransition('arriving', 'delivered')).not.toThrow();

    expect(() => assertShipmentTransition('pending', 'delivered')).toThrow(ShipmentTransitionError);
    expect(() => assertShipmentTransition('picked_up', 'assigned')).toThrow(ShipmentTransitionError);
    expect(() => assertShipmentTransition('delivered', 'in_transit')).toThrow(ShipmentTransitionError);
    expect(() => assertShipmentTransition('cancelled', 'assigned')).toThrow(ShipmentTransitionError);
  });

  it('despacho automático e intentos fallidos', () => {
    // Aceptar la oferta desde pendiente o listo para retirar; el backoffice puede reasignar antes del retiro.
    expect(() => assertShipmentTransition('pending', 'accepted')).not.toThrow();
    expect(() => assertShipmentTransition('ready_for_pickup', 'accepted')).not.toThrow();
    expect(() => assertShipmentTransition('accepted', 'picked_up')).not.toThrow();
    expect(() => assertShipmentTransition('accepted', 'assigned')).not.toThrow();
    expect(() => assertShipmentTransition('accepted', 'accepted')).toThrow(ShipmentTransitionError);
    // Intento fallido desde en camino o llegando; se reintenta volviendo a en camino.
    expect(() => assertShipmentTransition('in_transit', 'failed_attempt')).not.toThrow();
    expect(() => assertShipmentTransition('arriving', 'failed_attempt')).not.toThrow();
    expect(() => assertShipmentTransition('failed_attempt', 'in_transit')).not.toThrow();
    expect(() => assertShipmentTransition('picked_up', 'failed_attempt')).toThrow(ShipmentTransitionError);
    expect(() => assertShipmentTransition('failed_attempt', 'delivered')).toThrow(ShipmentTransitionError);
    // Pedido: aceptar = en preparación; el intento fallido no mueve el pedido.
    expect(orderStepsFor('accepted', 'paid')).toEqual(['preparing']);
    expect(orderStepsFor('failed_attempt', 'in_transit')).toEqual([]);
  });

  it('pasos del pedido que acompañan al envío, sin repetir los ya dados', () => {
    expect(orderStepsFor('assigned', 'paid')).toEqual(['preparing']);
    expect(orderStepsFor('assigned', 'created')).toEqual(['preparing']); // contra entrega
    expect(orderStepsFor('assigned', 'preparing')).toEqual([]);
    expect(orderStepsFor('picked_up', 'preparing')).toEqual(['shipped']);
    expect(orderStepsFor('in_transit', 'shipped')).toEqual(['in_transit']);
    expect(orderStepsFor('arriving', 'in_transit')).toEqual([]);
    expect(orderStepsFor('delivered', 'shipped')).toEqual(['in_transit', 'delivered']);
    expect(orderStepsFor('delivered', 'delivered')).toEqual([]);
    expect(() => orderStepsFor('assigned', 'cancelled')).toThrow(/cancelled/);
  });

  it('ETA de respaldo: ~1 km en línea recta a 22 km/h son unos 3,5 minutos', () => {
    const eta = fallbackEtaSeconds({ lat: -0.18, lng: -78.48 }, { lat: -0.171, lng: -78.48 });
    expect(eta).toBeGreaterThan(190);
    expect(eta).toBeLessThan(220);
  });

  it('la hora de la posición no puede ser del futuro ni muy vieja', () => {
    const now = new Date('2026-10-05T15:00:00Z');
    expect(() => assertRecentPosition(new Date('2026-10-05T14:59:00Z'), now)).not.toThrow();
    expect(() => assertRecentPosition(new Date('2026-10-05T15:00:30Z'), now)).not.toThrow();
    expect(() => assertRecentPosition(new Date('2026-10-05T15:05:00Z'), now)).toThrow(StalePositionError);
    expect(() => assertRecentPosition(new Date('2026-10-05T13:00:00Z'), now)).toThrow(StalePositionError);
  });

  it('solo se sigue en vivo con el paquete en manos del motorizado', () => {
    expect(isLive('assigned')).toBe(false);
    expect(isLive('picked_up')).toBe(true);
    expect(isLive('arriving')).toBe(true);
    expect(isLive('delivered')).toBe(false);
  });
});
