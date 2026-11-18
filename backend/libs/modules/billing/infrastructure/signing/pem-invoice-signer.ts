import { readFileSync } from 'node:fs';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../../shared-kernel';
import { InvoiceSigner } from '../../application/ports';
import { SigningMaterial, signXades } from './xades';

/** Lee el certificado y la clave PEM y verifica que formen un par. */
export function loadSigningMaterial(certPath: string, keyPath: string, now = new Date()): SigningMaterial {
  const read = (p: string, what: string) => {
    try {
      return readFileSync(resolve(p));
    } catch {
      throw new Error(`No se pudo leer ${what} de firma en ${resolve(p)} (genéralo con scripts/generate-sri-cert.sh)`);
    }
  };
  const cert = new X509Certificate(read(certPath, 'el certificado'));
  const key = createPrivateKey(read(keyPath, 'la clave privada'));
  if (!cert.checkPrivateKey(key)) throw new Error('La clave privada no corresponde al certificado de firma');
  if (new Date(cert.validTo) < now) throw new Error(`El certificado de firma venció el ${cert.validTo}`);
  return { key, cert };
}

/**
 * Firma con el certificado de SRI_CERT_PATH / SRI_KEY_PATH. Se carga al primer uso: la API no
 * firma, así que no necesita los archivos; el worker falla con un mensaje claro si faltan.
 */
@Injectable()
export class PemInvoiceSigner extends InvoiceSigner {
  private material?: SigningMaterial;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  sign(xml: string, now: Date): string {
    this.material ??= loadSigningMaterial(this.config.billing.certPath, this.config.billing.keyPath, now);
    return signXades(xml, this.material, { now });
  }
}
