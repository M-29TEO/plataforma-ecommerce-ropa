import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../shared-kernel';

/**
 * "Client secret" del pago (como el de Stripe): lo recibe quien hizo el checkout y le permite
 * consultar el estado del pago y subir el comprobante de transferencia sin cuenta (invitado).
 * Es un HMAC del id, así no hay que guardarlo; conocer solo el id del pago no basta.
 */
@Injectable()
export class PaymentSecrets {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  issue(paymentId: string): string {
    return createHmac('sha256', this.config.jwtSecret).update(`payment-client-secret:${paymentId}`).digest('base64url');
  }

  verify(paymentId: string, secret: string | undefined): boolean {
    if (!secret) return false;
    const expected = Buffer.from(this.issue(paymentId));
    const given = Buffer.from(secret);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
