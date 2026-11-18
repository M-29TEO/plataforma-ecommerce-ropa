import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { PasswordHasher } from '../application/ports';

/**
 * argon2id con los parámetros mínimos que recomienda OWASP (19 MiB, 2 pasadas, 1 hilo).
 * Los parámetros y la sal quedan dentro del hash ($argon2id$v=19$m=...): subirlos más
 * adelante no invalida los hashes existentes.
 */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19 * 1024, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class Argon2PasswordHasher extends PasswordHasher {
  hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // Hash corrupto o de otro formato: se trata como contraseña incorrecta.
      return false;
    }
  }
}
