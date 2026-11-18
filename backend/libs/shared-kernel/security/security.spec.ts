import { randomBytes } from 'node:crypto';
import { isAllowedPushEndpoint } from '../../modules/notifications/domain/push-endpoint';
import { AppConfig, loadConfig } from '../config/app-config';
import { isSafeStorageKey, sniffFileType } from '../storage/object-storage';
import { redact } from './audit.interceptor';
import { FieldCipher, secretboxOpen, secretboxSeal } from './field-cipher';

const BASE_ENV = { DATABASE_URL: 'postgres://x', JWT_SECRET: 'secreto-de-prueba', PAYSIM_SECRET: 'x' };

describe('claves de almacenamiento (path traversal hacia SeaweedFS)', () => {
  it.each([
    'returns/photos/t/u/0b4f8d1e-2c3a-4b5c-9d6e-7f8a9b0c1d2e.jpg',
    'billing/t/2026/10/0110202601179000000000120010010000000011234567813/ride.pdf',
    'reports/exports/t/abc.xlsx',
  ])('acepta %p', (key) => expect(isSafeStorageKey(key)).toBe(true));

  it.each([
    'returns/photos/t/u/../../../payments/vouchers/x.pdf',
    'reviews/t/u/%2e%2e/%2e%2e/x',
    'reviews/t/u/./x.jpg',
    '/etc/passwd',
    'a//b',
    'a/b?x=1',
    'a/b#x',
    'a\\b',
    'a/b c',
    '',
  ])('rechaza %p', (key) => expect(isSafeStorageKey(key)).toBe(false));
});

describe('sniffFileType (magic bytes, no el Content-Type del cliente)', () => {
  it('reconoce JPG, PNG, WEBP y PDF', () => {
    expect(sniffFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffFileType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('image/webp');
    expect(sniffFileType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
  });

  it('un HTML disfrazado no es ninguno', () => {
    expect(sniffFileType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffFileType(Buffer.alloc(0))).toBeNull();
  });
});

describe('isAllowedPushEndpoint (SSRF del worker)', () => {
  const hosts = ['fcm.googleapis.com', '*.push.services.mozilla.com', 'web.push.apple.com'];

  it.each(['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/Q'])(
    'acepta %p',
    (url) => expect(isAllowedPushEndpoint(url, hosts)).toBe(true),
  );

  it.each([
    'http://fcm.googleapis.com/x',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/x',
    'https://fcm.googleapis.com.evil.test/x',
    'https://evil.test/fcm.googleapis.com',
    'https://push.services.mozilla.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://user:pass@fcm.googleapis.com/x',
    'no es una url',
  ])('rechaza %p', (url) => expect(isAllowedPushEndpoint(url, hosts)).toBe(false));
});

describe('redact (cuerpo guardado en la auditoría)', () => {
  it('oculta credenciales y secretos a cualquier profundidad', () => {
    expect(
      redact({ email: 'a@b.ec', password: 'x', nested: { token: 't', code: '123456', note: 'ok' }, keys: { p256dh: 'k', auth: 's' } }),
    ).toEqual({ email: 'a@b.ec', password: '[redactado]', nested: { token: '[redactado]', code: '[redactado]', note: 'ok' }, keys: { p256dh: '[redactado]', auth: '[redactado]' } });
  });

  it('acota strings, arrays y profundidad', () => {
    const out = redact({ s: 'x'.repeat(600), a: Array.from({ length: 80 }, (_, i) => i), d: { a: { b: { c: { d: 1 } } } } }) as Record<string, any>;
    expect(out.s).toHaveLength(501);
    expect(out.a).toHaveLength(50);
    expect(out.d.a.b.c).toBe('[…]');
  });
});

describe('FieldCipher (libsodium crypto_secretbox)', () => {
  const key = randomBytes(32);
  const previous = randomBytes(32);
  const cipher = (current: Buffer, prev: Buffer | null = null) =>
    new FieldCipher({ security: { dataEncryptionKey: current, dataEncryptionKeyPrevious: prev } } as unknown as AppConfig);

  it('cifra con nonce aleatorio y descifra', async () => {
    const a = await cipher(key).sealString('secreto');
    const b = await cipher(key).sealString('secreto');
    expect(a.equals(b)).toBe(false);
    expect(a.toString('latin1')).not.toContain('secreto');
    expect(await cipher(key).openString(a)).toBe('secreto');
  });

  it('un byte alterado o una clave distinta fallan', async () => {
    const sealed = await secretboxSeal(key, Buffer.from('secreto'));
    sealed[sealed.length - 1] ^= 1;
    await expect(secretboxOpen(key, sealed)).rejects.toThrow();
    await expect(cipher(randomBytes(32)).open(await secretboxSeal(key, Buffer.from('x')))).rejects.toThrow();
  });

  it('rotación: lo cifrado con la clave anterior se lee e indica que hay que recifrarlo', async () => {
    const old = await cipher(previous).sealString('viejo');
    const opened = await cipher(key, previous).open(old);
    expect([opened.plain.toString(), opened.needsReseal]).toEqual(['viejo', true]);
    expect((await cipher(key, previous).open(await cipher(key).sealString('nuevo'))).needsReseal).toBe(false);
  });
});

describe('configuración de seguridad', () => {
  it('por defecto: sin orígenes CORS, rate limit con Valkey y clave derivada (desarrollo)', () => {
    const c = loadConfig(BASE_ENV).security;
    expect(c.corsOrigins).toEqual([]);
    expect(c.rateLimit).toEqual({ enabled: true, storage: 'valkey' });
    expect(c.dataEncryptionKeyDerived).toBe(true);
    expect(c.dataEncryptionKey).toHaveLength(32);
  });

  it('CORS_ORIGINS sin comodines ni rutas', () => {
    expect(loadConfig({ ...BASE_ENV, CORS_ORIGINS: 'https://tienda.ec, http://localhost:3000/' }).security.corsOrigins).toEqual([
      'https://tienda.ec',
      'http://localhost:3000',
    ]);
    expect(() => loadConfig({ ...BASE_ENV, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
    expect(() => loadConfig({ ...BASE_ENV, CORS_ORIGINS: 'https://tienda.ec/admin' })).toThrow(/CORS_ORIGINS/);
  });

  it('producción exige JWT_SECRET largo, DELIVERY_OTP_SECRET y DATA_ENCRYPTION_KEY de 32 bytes', () => {
    const prod = { ...BASE_ENV, NODE_ENV: 'production', MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
    expect(() => loadConfig(prod)).toThrow(/JWT_SECRET/);
    const withJwt = { ...prod, JWT_SECRET: randomBytes(48).toString('base64') };
    expect(() => loadConfig(withJwt)).toThrow(/DELIVERY_OTP_SECRET/);
    expect(() => loadConfig({ ...withJwt, DELIVERY_OTP_SECRET: 'corto' })).toThrow(/DELIVERY_OTP_SECRET/);
    const strong = { ...withJwt, DELIVERY_OTP_SECRET: randomBytes(48).toString('base64') };
    expect(() => loadConfig(strong)).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...strong, DATA_ENCRYPTION_KEY: randomBytes(16).toString('base64') })).toThrow(/32 bytes/);
    expect(loadConfig({ ...strong, DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') }).security.dataEncryptionKeyDerived).toBe(false);
  });
});
