import { estimatedRoadMeters, haversineMeters, InvalidAreaError, normalizeArea, samePoint } from './geo';

const square = [
  [-78.49, -0.19],
  [-78.47, -0.19],
  [-78.47, -0.17],
  [-78.49, -0.17],
  [-78.49, -0.19],
];

describe('normalizeArea', () => {
  it('convierte Polygon y Feature en MultiPolygon', () => {
    expect(normalizeArea({ type: 'Polygon', coordinates: [square] })).toEqual({ type: 'MultiPolygon', coordinates: [[square]] });
    expect(normalizeArea({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [square] } }).coordinates).toHaveLength(1);
    expect(normalizeArea({ type: 'MultiPolygon', coordinates: [[square], [square]] }).coordinates).toHaveLength(2);
  });

  it.each([
    ['otro tipo', { type: 'Point', coordinates: [-78.4, -0.2] }, /no soportado/],
    ['anillo abierto', { type: 'Polygon', coordinates: [square.slice(0, 4).concat([[-78.48, -0.18]])] }, /no está cerrado/],
    ['menos de 4 posiciones', { type: 'Polygon', coordinates: [[square[0], square[1], square[0]]] }, /al menos 4/],
    ['lat/lng invertidos fuera de rango', { type: 'Polygon', coordinates: [[[-0.19, -178.49], [-0.19, -78.47], [-0.17, -78.47], [-0.19, -178.49]]] }, /fuera de rango/],
    ['no es geometría', 'hola', /Polygon o MultiPolygon/],
    ['posición no numérica', { type: 'Polygon', coordinates: [[['a', 'b'], ...square]] }, /\[longitud, latitud\]/],
  ])('rechaza %s', (_name, input, message) => {
    expect(() => normalizeArea(input)).toThrow(InvalidAreaError);
    expect(() => normalizeArea(input)).toThrow(message);
  });
});

describe('distancias', () => {
  it('haversine: La Carolina → Plaza Grande ≈ 5,1 km', () => {
    const d = haversineMeters({ lat: -0.1835, lng: -78.4855 }, { lat: -0.2203, lng: -78.5122 });
    expect(d).toBeGreaterThan(4_900);
    expect(d).toBeLessThan(5_200);
  });

  it('la estimación por calle aplica el factor 1,3', () => {
    const a = { lat: -0.15, lng: -78.485 };
    const b = { lat: -0.18, lng: -78.485 };
    expect(estimatedRoadMeters(a, b)).toBe(Math.round(haversineMeters(a, b) * 1.3));
  });

  it('samePoint tolera el redondeo de JSON', () => {
    expect(samePoint({ lat: -0.1807, lng: -78.4678 }, { lat: -0.18070000001, lng: -78.4678 })).toBe(true);
    expect(samePoint({ lat: -0.1807, lng: -78.4678 }, { lat: -0.1808, lng: -78.4678 })).toBe(false);
  });
});
