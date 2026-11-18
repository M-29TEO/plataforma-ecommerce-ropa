import { describe, expect, it } from 'vitest';
import { appendTrail, bounds, ease, lerp, showDeliveryCode, stepOf } from './tracking';

describe('seguimiento en vivo', () => {
  it('paso de la línea de tiempo por estado', () => {
    expect(stepOf('pending')).toBe(0);
    expect(stepOf('in_transit')).toBe(3);
    expect(stepOf('delivered')).toBe(5);
    expect(stepOf('desconocido')).toBe(0);
    expect(stepOf('accepted')).toBe(1);
    expect(stepOf('failed_attempt')).toBe(3);
  });

  it('muestra el código de entrega solo mientras va en camino', () => {
    expect(showDeliveryCode({ status: 'in_transit', deliveryCode: '0427' })).toBe(true);
    expect(showDeliveryCode({ status: 'failed_attempt', deliveryCode: '0427' })).toBe(true);
    expect(showDeliveryCode({ status: 'accepted', deliveryCode: '0427' })).toBe(false);
    expect(showDeliveryCode({ status: 'delivered', deliveryCode: '0427' })).toBe(false);
    expect(showDeliveryCode({ status: 'arriving', deliveryCode: null })).toBe(false);
  });

  it('interpola y acota t', () => {
    expect(lerp({ lat: 0, lng: 0 }, { lat: 1, lng: 2 }, 0.5)).toEqual({ lat: 0.5, lng: 1 });
    expect(lerp({ lat: 0, lng: 0 }, { lat: 1, lng: 2 }, 3)).toEqual({ lat: 1, lng: 2 });
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5);
  });

  it('límites del mapa con los puntos presentes', () => {
    expect(bounds([null, { lat: -0.2, lng: -78.5 }, { lat: -0.1, lng: -78.4 }])).toEqual([
      [-78.5, -0.2],
      [-78.4, -0.1],
    ]);
    expect(bounds([null, undefined])).toBeNull();
  });

  it('recorrido sin puntos repetidos y con tope', () => {
    const t = appendTrail(appendTrail([], { lat: 1, lng: 1 }), { lat: 1, lng: 1 });
    expect(t).toHaveLength(1);
    let long: Array<{ lat: number; lng: number }> = [];
    for (let i = 0; i < 10; i++) long = appendTrail(long, { lat: i, lng: i }, 5);
    expect(long.map((p) => p.lat)).toEqual([5, 6, 7, 8, 9]);
  });
});
