import { ValidationError } from '../../../shared-kernel';
import { normalizeRuc } from './supplier';
import { assertValidPoint, normalizeWarehouseCode } from './warehouse';

describe('Bodega', () => {
  it('normaliza el código', () => {
    expect(normalizeWarehouseCode(' uio-01 ')).toBe('UIO-01');
    expect(() => normalizeWarehouseCode('x')).toThrow(ValidationError);
    expect(() => normalizeWarehouseCode('con espacio')).toThrow(ValidationError);
  });

  it('valida coordenadas WGS84', () => {
    expect(() => assertValidPoint({ lat: -0.18, lng: -78.47 })).not.toThrow();
    expect(() => assertValidPoint({ lat: 91, lng: 0 })).toThrow(ValidationError);
    expect(() => assertValidPoint({ lat: 0, lng: -181 })).toThrow(ValidationError);
    expect(() => assertValidPoint({ lat: Number.NaN, lng: 0 })).toThrow(ValidationError);
  });
});

describe('Proveedor · RUC', () => {
  it('acepta RUC válidos', () => {
    expect(normalizeRuc('1790012345001')).toBe('1790012345001');
    expect(normalizeRuc(' 0992345678001 ')).toBe('0992345678001');
  });

  it.each(['179001234500', '17900123450011', '2590012345001', '1790012345000', 'abcdefghijklm'])(
    'rechaza %s',
    (ruc) => {
      expect(() => normalizeRuc(ruc)).toThrow(ValidationError);
    },
  );
});
