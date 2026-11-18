import { buildAccessKey, isValidAccessKey, mod11CheckDigit, parseAccessKey } from './access-key';
import { InvalidAccessKeyError } from './errors';

/**
 * Casos conocidos: claves de acceso publicadas por el SRI y el ejemplo del procedimiento
 * módulo 11 de la ficha técnica. Si el algoritmo cambia, estos casos fallan.
 */
const FICHA_TECNICA = '2110201101179214673900110020010000000011234567813';
const PUBLICADA = '0503201201176001321000110010030009900641234567814';

describe('módulo 11', () => {
  test('ejemplo del procedimiento de la ficha técnica: 41261533 → 6', () => {
    expect(mod11CheckDigit('41261533')).toBe(6);
  });

  test.each([
    [FICHA_TECNICA, 3],
    [PUBLICADA, 4],
  ])('dígito verificador de la clave conocida %s', (key, digit) => {
    expect(mod11CheckDigit(key.slice(0, 48))).toBe(digit);
  });

  // Mismo prefijo que la clave de la ficha técnica, con otro código numérico.
  test('si 11 − (suma mod 11) da 11, el dígito es 0', () => {
    expect(mod11CheckDigit('211020110117921467390011002001000000001123456791')).toBe(0); // suma 451 = 41 × 11
    expect(mod11CheckDigit('211020110117921467390011002001000000001123456841')).toBe(0); // suma 440
  });

  test('si da 10, el dígito es 1', () => {
    expect(mod11CheckDigit('211020110117921467390011002001000000001123456721')).toBe(1); // suma 430 → 430 mod 11 = 1
    expect(mod11CheckDigit('211020110117921467390011002001000000001123456931')).toBe(1);
  });

  test('solo acepta dígitos', () => {
    expect(() => mod11CheckDigit('12a4')).toThrow(InvalidAccessKeyError);
  });
});

describe('clave de acceso', () => {
  test('arma la clave de la ficha técnica a partir de sus campos', () => {
    const key = buildAccessKey({
      issueDate: '2011-10-21',
      docType: '01',
      ruc: '1792146739001',
      environment: 1,
      establishment: '002',
      emissionPoint: '001',
      sequential: 1,
      numericCode: '12345678',
      emissionType: '1',
    });
    expect(key).toBe(FICHA_TECNICA);
    expect(key).toHaveLength(49);
  });

  test('arma la otra clave publicada (secuencial 990064, serie 001-003)', () => {
    expect(
      buildAccessKey({
        issueDate: '2012-03-05',
        docType: '01',
        ruc: '1760013210001',
        environment: 1,
        establishment: '001',
        emissionPoint: '003',
        sequential: 990064,
        numericCode: '12345678',
        emissionType: '1',
      }),
    ).toBe(PUBLICADA);
  });

  test('parseAccessKey devuelve los campos (ida y vuelta)', () => {
    const parts = parseAccessKey(PUBLICADA);
    expect(parts).toEqual({
      issueDate: '2012-03-05',
      docType: '01',
      ruc: '1760013210001',
      environment: 1,
      establishment: '001',
      emissionPoint: '003',
      sequential: 990064,
      numericCode: '12345678',
      emissionType: '1',
    });
    expect(buildAccessKey(parts)).toBe(PUBLICADA);
  });

  test('isValidAccessKey detecta un dígito cambiado, una longitud distinta o letras', () => {
    expect(isValidAccessKey(FICHA_TECNICA)).toBe(true);
    expect(isValidAccessKey(`${FICHA_TECNICA.slice(0, 48)}4`)).toBe(false);
    expect(isValidAccessKey(`3${FICHA_TECNICA.slice(1)}`)).toBe(false);
    expect(isValidAccessKey(FICHA_TECNICA.slice(1))).toBe(false);
    expect(isValidAccessKey(`${FICHA_TECNICA.slice(0, 48)}X`)).toBe(false);
  });

  test('rechaza campos con longitud o rango inválidos', () => {
    const ok = {
      issueDate: '2026-09-30',
      docType: '01',
      ruc: '1790000000001',
      environment: 1 as const,
      establishment: '001',
      emissionPoint: '001',
      sequential: 1,
      numericCode: '00000001',
      emissionType: '1' as const,
    };
    expect(() => buildAccessKey({ ...ok, ruc: '179000000001' })).toThrow(InvalidAccessKeyError);
    expect(() => buildAccessKey({ ...ok, sequential: 0 })).toThrow(InvalidAccessKeyError);
    expect(() => buildAccessKey({ ...ok, sequential: 1_000_000_000 })).toThrow(InvalidAccessKeyError);
    expect(() => buildAccessKey({ ...ok, issueDate: '30/09/2026' })).toThrow(InvalidAccessKeyError);
    expect(() => buildAccessKey({ ...ok, numericCode: '1234567' })).toThrow(InvalidAccessKeyError);
    expect(buildAccessKey({ ...ok, sequential: 999_999_999 }).slice(30, 39)).toBe('999999999');
  });
});
