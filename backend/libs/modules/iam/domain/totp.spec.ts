import { base32Decode, base32Encode, hotp, otpauthUri, totpCode, totpStep, verifyTotp } from './totp';

/** Secreto de los vectores de prueba de RFC 4226 y RFC 6238 (SHA-1): "12345678901234567890". */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const at = (unixSeconds: number) => new Date(unixSeconds * 1000);

describe('HOTP (RFC 4226, apéndice D)', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [9, '520489'],
  ])('contador %i → %s', (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });
});

describe('TOTP (RFC 6238, apéndice B, SHA-1, 8 dígitos)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('T=%i → %s', (t, code) => {
    expect(totpCode(RFC_SECRET, at(t), 8)).toBe(code);
  });

  it('con 6 dígitos son los últimos 6 del vector', () => {
    expect(totpCode(RFC_SECRET, at(1111111109))).toBe('081804');
  });
});

describe('verifyTotp', () => {
  const now = at(1_759_420_800); // 2025-10-02T16:00:00Z
  const step = totpStep(now);

  it('acepta el paso actual y ±1 (desfase del reloj del teléfono) y devuelve el paso', () => {
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now)).toBe(step + 1);
  });

  it('rechaza ±2 pasos, otro secreto y formatos inválidos', () => {
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now)).toBeNull();
    expect(verifyTotp(Buffer.from('otro-secreto-de-20-b'), hotp(RFC_SECRET, step), now)).toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 345']) expect(verifyTotp(RFC_SECRET, bad, now)).toBeNull();
  });
});

describe('base32 (RFC 4648)', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('"%s" ↔ %s', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(plain);
  });

  it('decodifica sin importar minúsculas, espacios ni relleno', () => {
    expect(base32Decode('mzxw 6ytb oi==').toString()).toBe('foobar');
  });
});

it('otpauthUri arma la URI que leen las apps autenticadoras', () => {
  const uri = otpauthUri('Moda Demo', 'admin@demo.test', Buffer.from('foobar'));
  expect(uri).toBe('otpauth://totp/Moda%20Demo%3Aadmin%40demo.test?secret=MZXW6YTBOI&issuer=Moda+Demo&algorithm=SHA1&digits=6&period=30');
});
