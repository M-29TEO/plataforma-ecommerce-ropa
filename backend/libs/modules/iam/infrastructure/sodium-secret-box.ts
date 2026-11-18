import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, secretboxOpen, secretboxSeal } from '../../../shared-kernel';
import { SecretBox } from '../application/ports';

/**
 * libsodium crypto_secretbox (XSalsa20-Poly1305) con la clave de 32 bytes MFA_ENCRYPTION_KEY.
 * Formato guardado: nonce aleatorio (24 bytes) || texto cifrado + MAC (el mismo de FieldCipher).
 * Quien lea la base sin la clave no obtiene los secretos TOTP; alterar un byte hace fallar open().
 */
@Injectable()
export class SodiumSecretBox extends SecretBox {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  seal(plain: Buffer): Promise<Buffer> {
    return secretboxSeal(this.config.iam.mfaEncryptionKey, plain);
  }

  open(sealed: Buffer): Promise<Buffer> {
    return secretboxOpen(this.config.iam.mfaEncryptionKey, sealed);
  }
}
