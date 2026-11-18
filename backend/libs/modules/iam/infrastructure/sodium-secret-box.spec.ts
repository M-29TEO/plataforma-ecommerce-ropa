import { randomBytes } from 'node:crypto';
import { AppConfig } from '../../../shared-kernel';
import { SodiumSecretBox } from './sodium-secret-box';

function boxWith(key: Buffer): SodiumSecretBox {
  return new SodiumSecretBox({ iam: { mfaEncryptionKey: key, mfaEncryptionKeyDerived: false } } as unknown as AppConfig);
}

describe('SodiumSecretBox (libsodium crypto_secretbox)', () => {
  const key = randomBytes(32);
  const secret = Buffer.from('12345678901234567890');

  it('cifra y descifra; cada cifrado usa un nonce distinto', async () => {
    const box = boxWith(key);
    const a = await box.seal(secret);
    const b = await box.seal(secret);
    expect(a).toHaveLength(24 + 16 + secret.length); // nonce + MAC + texto
    expect(a.equals(b)).toBe(false);
    expect(a.includes(secret)).toBe(false);
    expect((await box.open(a)).equals(secret)).toBe(true);
  });

  it('un byte alterado o una clave distinta hacen fallar open()', async () => {
    const sealed = await boxWith(key).seal(secret);
    const tampered = Buffer.from(sealed);
    tampered[30] ^= 0x01;
    await expect(boxWith(key).open(tampered)).rejects.toThrow();
    await expect(boxWith(randomBytes(32)).open(sealed)).rejects.toThrow();
    await expect(boxWith(key).open(Buffer.alloc(10))).rejects.toThrow();
  });
});
