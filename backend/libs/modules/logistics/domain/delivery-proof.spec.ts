import { LockedError, ValidationError } from '../../../shared-kernel';
import {
  assertCodCollected,
  assertOtpNotLocked,
  deliveryOtpCode,
  OTP_MAX_FAILURES,
  otpHash,
  otpMatches,
  OtpLockedError,
  PROOF_PHOTO_MAX_BYTES,
  showsDeliveryCode,
  validateProofFile,
} from './delivery-proof';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const file = (buffer: Buffer, mimetype = 'image/png') => ({ buffer, mimetype, size: buffer.length });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as ValidationError).code;
  }
  return undefined;
}

describe('Prueba de entrega: código (OTP), archivos y contra entrega', () => {
  it('el código se deriva del envío: 4 dígitos, estable y distinto por envío y por secreto', () => {
    const a = deliveryOtpCode('secreto', '11111111-1111-1111-1111-111111111111');
    expect(a).toMatch(/^\d{4}$/);
    expect(deliveryOtpCode('secreto', '11111111-1111-1111-1111-111111111111')).toBe(a);
    const others = ['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'];
    expect(others.map((id) => deliveryOtpCode('secreto', id)).some((c) => c !== a)).toBe(true);
    expect(['otro', 'tercero', 'cuarto'].map((s) => deliveryOtpCode(s, '11111111-1111-1111-1111-111111111111')).some((c) => c !== a)).toBe(true);
  });

  it('se guarda el hash y se verifica en tiempo constante', () => {
    const hash = otpHash('0427');
    expect(hash).toHaveLength(32);
    expect(otpMatches('0427', hash)).toBe(true);
    expect(otpMatches('0428', hash)).toBe(false);
    expect(otpMatches('427', hash)).toBe(false);
  });

  it('bloquea tras 5 códigos incorrectos', () => {
    expect(assertOtpNotLocked(0)).toBe(OTP_MAX_FAILURES);
    expect(assertOtpNotLocked(4)).toBe(1);
    expect(() => assertOtpNotLocked(5)).toThrow(OtpLockedError);
    expect(new OtpLockedError()).toBeInstanceOf(LockedError);
  });

  it('el cliente ve el código solo con motorizado y mientras el paquete va en camino', () => {
    for (const status of ['picked_up', 'in_transit', 'arriving', 'failed_attempt']) expect(showsDeliveryCode({ carrierType: 'rider', status })).toBe(true);
    for (const status of ['pending', 'ready_for_pickup', 'accepted', 'assigned', 'delivered']) expect(showsDeliveryCode({ carrierType: 'rider', status })).toBe(false);
    expect(showsDeliveryCode({ carrierType: 'courier', status: 'in_transit' })).toBe(false);
  });

  it('foto JPG/PNG ≤ 5 MB y firma PNG ≤ 1 MB, por magic bytes y no por el mimetype declarado', () => {
    expect(validateProofFile('photo', file(JPEG, 'image/jpeg'))).toEqual({ contentType: 'image/jpeg', ext: 'jpg' });
    expect(validateProofFile('photo', file(PNG))).toEqual({ contentType: 'image/png', ext: 'png' });
    expect(validateProofFile('signature', file(PNG))).toEqual({ contentType: 'image/png', ext: 'png' });

    expect(codeOf(() => validateProofFile('photo', undefined))).toBe('PROOF_PHOTO_REQUIRED');
    expect(codeOf(() => validateProofFile('signature', undefined))).toBe('PROOF_SIGNATURE_REQUIRED');
    expect(codeOf(() => validateProofFile('signature', file(JPEG, 'image/png')))).toBe('PROOF_SIGNATURE_TYPE');
    expect(codeOf(() => validateProofFile('photo', file(Buffer.from('<html>hola</html>'), 'image/png')))).toBe('PROOF_PHOTO_TYPE');
    expect(codeOf(() => validateProofFile('photo', { buffer: PNG, mimetype: 'image/png', size: PROOF_PHOTO_MAX_BYTES + 1 }))).toBe('PROOF_PHOTO_TOO_LARGE');
    expect(codeOf(() => validateProofFile('signature', { buffer: PNG, mimetype: 'image/png', size: 1024 * 1024 + 1 }))).toBe('PROOF_SIGNATURE_TOO_LARGE');
  });

  it('contra entrega: se cobra exactamente el monto', () => {
    expect(() => assertCodCollected('0.00', undefined)).not.toThrow();
    expect(() => assertCodCollected('0.00', '0')).not.toThrow();
    expect(() => assertCodCollected('34.50', '34.5')).not.toThrow();
    expect(codeOf(() => assertCodCollected('34.50', undefined))).toBe('COD_AMOUNT_MISMATCH');
    expect(codeOf(() => assertCodCollected('34.50', '30.00'))).toBe('COD_AMOUNT_MISMATCH');
    expect(codeOf(() => assertCodCollected('0.00', '5.00'))).toBe('COD_AMOUNT_MISMATCH');
  });
});
