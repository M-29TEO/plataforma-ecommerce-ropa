import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MAX_AREA_VERTICES } from '../../domain/geo';
import { UpdateZoneDto } from './logistics.dto';

const square = [[[-78.6, -0.3], [-78.59, -0.3], [-78.59, -0.29], [-78.6, -0.29], [-78.6, -0.3]]];
const errorsFor = (area: unknown) => validateSync(plainToInstance(UpdateZoneDto, { area })).map((e) => e.property);

describe('IsBoundedGeoJsonArea', () => {
  it('acepta Polygon, MultiPolygon y Feature con una de esas geometrías', () => {
    expect(errorsFor({ type: 'Polygon', coordinates: square })).toEqual([]);
    expect(errorsFor({ type: 'MultiPolygon', coordinates: [square, square] })).toEqual([]);
    expect(errorsFor({ type: 'Feature', properties: { name: 'Norte' }, geometry: { type: 'Polygon', coordinates: square } })).toEqual([]);
  });

  it('rechaza otros tipos, miembros extra, coordenadas no numéricas o fuera de rango', () => {
    expect(errorsFor({ type: 'Point', coordinates: [-78.5, -0.2] })).toEqual(['area']);
    expect(errorsFor({ type: 'Polygon', coordinates: square, extra: 'x'.repeat(10_000) })).toEqual(['area']);
    expect(errorsFor({ type: 'Polygon', coordinates: [[['-78.6', -0.3]]] })).toEqual(['area']);
    expect(errorsFor({ type: 'Polygon', coordinates: [[[-200, -0.3]]] })).toEqual(['area']);
    expect(errorsFor({ type: 'Polygon', coordinates: [[[-78.6, 95]]] })).toEqual(['area']);
    expect(errorsFor({ type: 'Polygon', coordinates: [[[[-78.6, -0.3]]]] })).toEqual(['area']);
    expect(errorsFor({ type: 'Feature', properties: { blob: 'x'.repeat(3000) }, geometry: { type: 'Polygon', coordinates: square } })).toEqual(['area']);
  });

  it(`corta en ${MAX_AREA_VERTICES} vértices en total`, () => {
    const ring = (n: number) => Array.from({ length: n }, (_, i) => [-78.6 + i * 1e-5, -0.3]);
    expect(errorsFor({ type: 'Polygon', coordinates: [ring(MAX_AREA_VERTICES)] })).toEqual([]);
    expect(errorsFor({ type: 'MultiPolygon', coordinates: [[ring(MAX_AREA_VERTICES)], [ring(1)]] })).toEqual(['area']);
  });
});
