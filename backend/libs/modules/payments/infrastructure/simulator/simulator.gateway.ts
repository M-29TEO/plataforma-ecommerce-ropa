import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, fromCents, toCents } from '../../../../shared-kernel';
import {
  CreateIntentInput,
  GatewayNotification,
  GatewayRefundInput,
  GatewayRefundRejectedError,
  PaymentGatewayPort,
  PaymentIntent,
  WebhookHeaders,
} from '../../application/ports';
import { InvalidPaymentError } from '../../domain/errors';
import { PaymentMethod } from '../../domain/payment';
import { SIGNATURE_HEADER, signParams, signWebhook, verifyWebhookSignature } from './paysim-signature';

interface PaysimEvent {
  id?: unknown;
  type?: unknown;
  data?: {
    reference?: unknown;
    amount?: unknown;
    currency?: unknown;
    authorizationCode?: unknown;
    cardBrand?: unknown;
    last4?: unknown;
    failureCode?: unknown;
    failureMessage?: unknown;
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Adaptador de PaymentGatewayPort para el contenedor `pasarela-simulada` (simulators/payments).
 *
 * createIntent no llama al simulador: arma la URL de su página de pago con los datos del cobro
 * firmados con HMAC (el simulador verifica la firma y no necesita registro previo). Por eso se
 * puede llamar dentro de la transacción del checkout sin I/O. La referencia es derivada del id
 * del pago, así un reintento produce la misma.
 */
@Injectable()
export class SimulatorGateway extends PaymentGatewayPort {
  readonly provider = 'simulator' as const;
  readonly methods: readonly PaymentMethod[] = ['card', 'deuna', 'pichincha', 'qr'];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  async createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    const providerRef = `ps_${input.paymentId.replace(/-/g, '')}`;
    const params: Record<string, string> = {
      ref: providerRef,
      amount: input.amount,
      currency: input.currency,
      order: input.orderNumber,
      method: input.method,
      exp: String(Math.floor(input.expiresAt.getTime() / 1000)),
      return: input.returnUrl,
    };
    const query = new URLSearchParams({ ...params, sig: signParams(this.config.payments.simulatorSecret, params) });
    return { providerRef, redirectUrl: `${this.config.payments.simulatorPublicUrl}/pay?${query.toString()}` };
  }

  /**
   * POST /refunds del simulador (servidor a servidor, por la red interna): cuerpo JSON firmado con
   * el mismo HMAC de los webhooks. 2xx = reverso hecho; 4xx = rechazado (no sirve reintentar);
   * 5xx, timeout o red caída = transitorio.
   */
  async refund(input: GatewayRefundInput): Promise<{ providerRef: string }> {
    const { simulatorSecret, simulatorApiUrl, refundTimeoutMs } = this.config.payments;
    const body = JSON.stringify({ refundId: input.refundId, reference: input.providerRef, amount: input.amount, currency: input.currency });
    const res = await fetch(`${simulatorApiUrl}/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signWebhook(simulatorSecret, body) },
      body,
      signal: AbortSignal.timeout(refundTimeoutMs),
    });
    const text = await res.text();
    let data: { id?: unknown; status?: unknown; error?: { code?: unknown; message?: unknown } } = {};
    try {
      data = JSON.parse(text);
    } catch {
      // cuerpo no JSON: se decide solo por el código HTTP
    }
    if (res.status >= 500) throw new Error(`La pasarela respondió ${res.status} al reverso`);
    if (!res.ok) {
      throw new GatewayRefundRejectedError(str(data.error?.message) ?? `HTTP ${res.status}`, str(data.error?.code) ?? 'REFUND_REJECTED');
    }
    const id = str(data.id);
    if (!id || data.status !== 'succeeded') throw new Error('Respuesta de reverso inesperada de la pasarela');
    return { providerRef: id };
  }

  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders): boolean {
    const raw = headers[SIGNATURE_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const { simulatorSecret, webhookToleranceSeconds } = this.config.payments;
    return verifyWebhookSignature(simulatorSecret, rawBody, header, webhookToleranceSeconds);
  }

  parseWebhook(rawBody: Buffer): GatewayNotification {
    let event: PaysimEvent;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as PaysimEvent;
    } catch {
      throw new InvalidPaymentError('INVALID_WEBHOOK', 'El webhook no es JSON válido');
    }
    const externalId = str(event?.id);
    const reference = str(event?.data?.reference);
    const type = event?.type;
    const amount = str(event?.data?.amount);
    if (!externalId || !reference || !amount || (type !== 'payment.approved' && type !== 'payment.rejected')) {
      throw new InvalidPaymentError('INVALID_WEBHOOK', 'El webhook no tiene id, tipo, referencia o monto válidos');
    }
    return {
      externalId,
      providerRef: reference,
      outcome: type === 'payment.approved' ? 'approved' : 'rejected',
      amount: fromCents(toCents(amount)),
      currency: str(event.data?.currency) ?? 'USD',
      authorizationCode: str(event.data?.authorizationCode),
      cardBrand: str(event.data?.cardBrand),
      cardLast4: /^\d{4}$/.test(String(event.data?.last4)) ? String(event.data?.last4) : null,
      failureCode: str(event.data?.failureCode),
      failureMessage: str(event.data?.failureMessage),
    };
  }
}
