import { describe, expect, it } from 'vitest';
import {
  cameraErrorMessage,
  cameraSupport,
  checkBarcode,
  createDebouncer,
  expandUpcE,
  gs1CheckDigit,
  missingIdBatches,
  normalizeBarcode,
  variantLabel,
} from './scanner';

describe('normalizeBarcode', () => {
  it('quita espacios, saltos y caracteres de control', () => {
    expect(normalizeBarcode('  7861234567890\r\n')).toBe('7861234567890');
    expect(normalizeBarcode('\u001d0107861234567890\t')).toBe('0107861234567890');
    expect(normalizeBarcode('SKU  CAM   01')).toBe('SKU CAM 01');
    expect(normalizeBarcode('\u0000\u0007')).toBe('');
  });

  it('corta a 64 caracteres (límite del API)', () => {
    expect(normalizeBarcode('x'.repeat(100))).toHaveLength(64);
  });
});

describe('dígito verificador EAN/UPC', () => {
  it('calcula el dígito GS1', () => {
    expect(gs1CheckDigit('400638133393')).toBe(1); // EAN-13 4006381333931
    expect(gs1CheckDigit('9638507')).toBe(4); // EAN-8 96385074
    expect(gs1CheckDigit('03600029145')).toBe(2); // UPC-A 036000291452
  });

  it('valida EAN-13, EAN-8, UPC-A y GTIN-14', () => {
    expect(checkBarcode('4006381333931')).toEqual({ kind: 'ean13', valid: true });
    expect(checkBarcode('4006381333932')).toEqual({ kind: 'ean13', valid: false });
    expect(checkBarcode('96385074')).toEqual({ kind: 'ean8', valid: true });
    expect(checkBarcode('036000291452')).toEqual({ kind: 'upca', valid: true });
    expect(checkBarcode('036000291453').valid).toBe(false);
    expect(checkBarcode('14006381333938')).toEqual({ kind: 'gtin14', valid: true });
  });

  it('expande y valida UPC-E', () => {
    expect(expandUpcE('04252614')).toBe('042100005264');
    expect(checkBarcode('04252614')).toEqual({ kind: 'upce', valid: true });
    expect(expandUpcE('23456789')).toBeNull();
  });

  it('los códigos alfanuméricos (Code 128/39, QR) no tienen verificador', () => {
    expect(checkBarcode('CAM-OX-AZ-M')).toEqual({ kind: 'other', valid: true });
    expect(checkBarcode('12345')).toEqual({ kind: 'other', valid: true });
  });
});

describe('createDebouncer', () => {
  it('ignora el mismo código antes de 1,5 s y acepta uno distinto', () => {
    let t = 0;
    const accept = createDebouncer(1500, () => t);
    expect(accept('A')).toBe(true);
    t = 500;
    expect(accept('A')).toBe(false);
    expect(accept('B')).toBe(true);
    t = 900;
    expect(accept('A')).toBe(true); // otro código intermedio reinicia
    t = 2399;
    expect(accept('A')).toBe(false);
    t = 2400;
    expect(accept('A')).toBe(true);
  });
});

describe('soporte de cámara', () => {
  it('exige contexto seguro', () => {
    expect(cameraSupport({ isSecureContext: false, hasGetUserMedia: true })).toBe('insecure');
    expect(cameraSupport({ isSecureContext: true, hasGetUserMedia: false })).toBe('unsupported');
    expect(cameraSupport({ isSecureContext: true, hasGetUserMedia: true })).toBe('ok');
  });

  it('traduce los errores de getUserMedia', () => {
    expect(cameraErrorMessage('NotAllowedError')).toMatch(/denegado/);
    expect(cameraErrorMessage('NotFoundError')).toMatch(/No se encontró una cámara/);
    expect(cameraErrorMessage('NotReadableError')).toMatch(/ocupada/);
    expect(cameraErrorMessage(undefined)).toMatch(/No se pudo abrir/);
  });
});

it('variantLabel une nombre, color y talla', () => {
  expect(variantLabel({ productName: 'Camisa Oxford', color: 'Azul', size: 'M' })).toBe('Camisa Oxford · Azul · M');
  expect(variantLabel({ productName: 'Gorra', color: null, size: null })).toBe('Gorra');
});

describe('missingIdBatches', () => {
  it('omite conocidos y repetidos, ordena y agrupa de a 100', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${String(i).padStart(3, '0')}`);
    const batches = missingIdBatches([...ids, 'id-000'], (id) => id === 'id-001');
    expect(batches.map((b) => b.length)).toEqual([100, 100, 49]);
    expect(batches[0][0]).toBe('id-000');
    expect(batches.flat()).not.toContain('id-001');
    expect(missingIdBatches(['b', 'a', ''], () => false, 1)).toEqual([['a'], ['b']]);
    expect(missingIdBatches(['a'], () => true)).toEqual([]);
  });
});
