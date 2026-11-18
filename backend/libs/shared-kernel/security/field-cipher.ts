import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import sodium from 'libsodium-wrappers';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/**
 * libsodium crypto_secretbox (XSalsa20-Poly1305): cifrado autenticado con una clave de 32 bytes.
 * Formato guardado en las columnas *_enc (bytea): nonce aleatorio (24 bytes) || texto cifrado + MAC.
 * Quien lea la base (o un backup) sin la clave no obtiene el secreto; alterar un byte hace fallar open.
 */
export async function secretboxSeal(key: Buffer, plain: Buffer): Promise<Buffer> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(plain, nonce, key);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(cipher)]);
}

/** Lanza si el MAC no verifica (dato alterado o de otra clave). */
export async function secretboxOpen(key: Buffer, sealed: Buffer): Promise<Buffer> {
  await sodium.ready;
  const n = sodium.crypto_secretbox_NONCEBYTES;
  if (sealed.length <= n + sodium.crypto_secretbox_MACBYTES) throw new Error('Dato cifrado demasiado corto');
  return Buffer.from(sodium.crypto_secretbox_open_easy(sealed.subarray(n), sealed.subarray(0, n), key));
}

/**
 * Cifrado de campos *_enc con DATA_ENCRYPTION_KEY (claves de Web Push, tokens de pago...).
 * Rotación: se publica la clave nueva en DATA_ENCRYPTION_KEY y la vieja en
 * DATA_ENCRYPTION_KEY_PREVIOUS; open() prueba ambas y `needsReseal` indica qué recifrar.
 * El 2FA (iam.users.mfa_secret_enc) usa el mismo formato con su propia clave (MFA_ENCRYPTION_KEY).
 */
@Injectable()
export class FieldCipher implements OnModuleInit {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    await sodium.ready;
  }

  seal(plain: Buffer): Promise<Buffer> {
    return secretboxSeal(this.config.security.dataEncryptionKey, plain);
  }

  async sealString(plain: string): Promise<Buffer> {
    return this.seal(Buffer.from(plain, 'utf8'));
  }

  async open(sealed: Buffer): Promise<{ plain: Buffer; needsReseal: boolean }> {
    try {
      return { plain: await secretboxOpen(this.config.security.dataEncryptionKey, sealed), needsReseal: false };
    } catch (error) {
      const previous = this.config.security.dataEncryptionKeyPrevious;
      if (!previous) throw error;
      return { plain: await secretboxOpen(previous, sealed), needsReseal: true };
    }
  }

  async openString(sealed: Buffer): Promise<string> {
    return (await this.open(sealed)).plain.toString('utf8');
  }
}
