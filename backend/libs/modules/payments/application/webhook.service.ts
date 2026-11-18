import { Injectable, Logger } from '@nestjs/common';
import { Database, Queryable } from '../../../shared-kernel';
import { GatewayNotConfiguredError, InvalidPaymentTransitionError } from '../domain/errors';
import { PaymentService } from './payment.service';
import { GatewayNotification, PaymentGatewayPort, PaymentRepository, WebhookHeaders, WebhookInboxRepository } from './ports';

/**
 * Resultado de recibir un webhook:
 *  - processed: se aplicó (pago capturado o rechazado).
 *  - duplicate: ese external_id ya se había recibido con firma válida; no se procesa de nuevo.
 *  - ignored: válido pero sin efecto (pago inexistente, ya capturado, vencido, monto distinto);
 *    queda en webhook_inbox.error para revisión.
 *  - invalid_signature: no se guarda nada (solo una línea en el log) y se responde 401.
 */
export type WebhookOutcome =
  | { outcome: 'processed'; paymentId: string; status: string }
  | { outcome: 'duplicate' }
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'invalid_signature' };

/**
 * El external id lo escribe quien manda el webhook (sin firma, cualquiera): sin caracteres de
 * control ni no imprimibles (falsificar líneas del log) y como mucho 64 caracteres.
 */
export function logSafe(value: string | null | undefined): string {
  const clean = String(value ?? '').replace(/[^\x20-\x7E]/g, '?');
  return clean.length > 64 ? `${clean.slice(0, 64)}…` : clean || '-';
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly db: Database,
    private readonly inbox: WebhookInboxRepository,
    private readonly payments: PaymentRepository,
    private readonly paymentService: PaymentService,
    private readonly gateway: PaymentGatewayPort,
  ) {}

  /**
   * Todo en UNA transacción: registrar en webhook_inbox, capturar/rechazar el pago, bitácora y
   * evento en el outbox. Si algo inesperado falla, se revierte también el registro del inbox y la
   * pasarela reintentará (responde 5xx).
   *
   * Idempotencia por (provider, external_id): el INSERT ... ON CONFLICT DO NOTHING hace que dos
   * entregas simultáneas del mismo evento se serialicen en el índice único; la segunda ve el
   * conflicto y responde "duplicate" sin procesar.
   *
   * La firma se verifica ANTES de interpretar el cuerpo: un webhook sin firma válida no se
   * guarda (si no, cualquiera llenaría webhook_inbox con payloads arbitrarios) y solo deja una
   * línea en el log. Por eso un id recibido con firma falsa tampoco "reserva" el id del evento
   * real. Las filas con signature_valid=false de antes de este cambio siguen sin bloquearlo: si
   * luego llega con firma válida, se reemplaza y se procesa.
   */
  async receive(provider: string, rawBody: Buffer, headers: WebhookHeaders): Promise<WebhookOutcome> {
    if (provider !== this.gateway.provider) throw new GatewayNotConfiguredError(provider);
    if (!this.gateway.verifyWebhook(rawBody, headers)) {
      this.logger.warn(`Webhook ${provider}/${logSafe(this.unverifiedExternalId(rawBody))} con firma inválida`);
      return { outcome: 'invalid_signature' };
    }
    const notification = this.gateway.parseWebhook(rawBody);
    const payload = JSON.parse(rawBody.toString('utf8')) as unknown;

    const result = await this.db.withTransaction(async (tx): Promise<WebhookOutcome> => {
      let inboxId = await this.inbox.insert(tx, {
        provider,
        externalId: notification.externalId,
        payload,
        signatureValid: true,
        error: null,
      });
      if (inboxId === null) {
        const existing = await this.inbox.findForUpdate(tx, provider, notification.externalId);
        if (!existing) throw new Error('Fila de webhook_inbox no encontrada tras conflicto');
        if (existing.signatureValid) return { outcome: 'duplicate' };
        await this.inbox.replaceWithValid(tx, existing.id, payload);
        inboxId = existing.id;
      }

      const applied = await this.apply(tx, provider, notification);
      await this.inbox.markProcessed(tx, inboxId, applied.outcome === 'ignored' ? applied.reason : null);
      return applied;
    });

    if (result.outcome === 'ignored') {
      this.logger.warn(`Webhook ${provider}/${logSafe(notification.externalId)} sin efecto: ${result.reason}`);
    }
    return result;
  }

  /** Solo para el log de un webhook rechazado: el id que dice traer, si se puede leer. */
  private unverifiedExternalId(rawBody: Buffer): string {
    try {
      return this.gateway.parseWebhook(rawBody).externalId;
    } catch {
      return '-';
    }
  }

  private async apply(tx: Queryable, provider: string, n: GatewayNotification): Promise<WebhookOutcome> {
    const payment = await this.payments.findByProviderRef(tx, provider, n.providerRef, { forUpdate: true });
    if (!payment) return { outcome: 'ignored', reason: 'PAYMENT_NOT_FOUND' };

    const p = payment.toJSON();
    if (n.amount !== p.amount || n.currency !== p.currency) {
      await this.payments.insertEvent(tx, p.id, {
        eventType: 'webhook_amount_mismatch',
        payload: { externalId: n.externalId, notified: `${n.amount} ${n.currency}`, expected: `${p.amount} ${p.currency}` },
      });
      return { outcome: 'ignored', reason: 'AMOUNT_MISMATCH' };
    }

    try {
      const change =
        n.outcome === 'approved'
          ? payment.capture(
              { source: `webhook:${n.externalId}`, authorizationCode: n.authorizationCode, cardBrand: n.cardBrand, cardLast4: n.cardLast4 },
            )
          : payment.fail(n.failureCode ?? 'REJECTED', n.failureMessage, `webhook:${n.externalId}`);
      if (!change.changed) return { outcome: 'ignored', reason: n.outcome === 'approved' ? 'ALREADY_CAPTURED' : 'ALREADY_FAILED' };
      await this.paymentService.apply(tx, payment, change);
      return { outcome: 'processed', paymentId: p.id, status: payment.status };
    } catch (error) {
      if (!(error instanceof InvalidPaymentTransitionError)) throw error;
      // Aprobación tardía de un pago vencido o cancelado: el dinero llegó pero el pedido ya no
      // existe como tal. Queda en la bitácora para reembolso manual (módulo de reembolsos pendiente).
      // Si venció pero el job aún no pasó, el estado efectivo es 'expired'.
      const status = String(error.details?.from ?? p.status);
      await this.payments.insertEvent(tx, p.id, {
        eventType: n.outcome === 'approved' ? 'late_approval' : 'late_rejection',
        payload: { externalId: n.externalId, status },
      });
      return { outcome: 'ignored', reason: `PAYMENT_NOT_OPEN:${status}` };
    }
  }
}
