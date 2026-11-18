import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Database } from '../../../shared-kernel';
import { Channel } from '../domain/channel';
import { onFailure, RetryPolicy } from '../domain/retry';
import {
  CHANNEL_PORTS,
  ChannelPort,
  ChannelSendError,
  NotificationRepository,
  OutgoingMessage,
  PushSubscriptionRepository,
  QueuedNotification,
} from './ports';

/** Tiempo que una réplica "se queda" con una notificación mientras la envía. */
const LEASE_SECONDS = 120;

export interface DispatchRun {
  sent: number;
  retried: number;
  failed: number;
}

/**
 * Envía lo que está en cola (fase 2 de 2), FUERA de toda transacción: un SMTP lento no bloquea el
 * relay ni deja conexiones abiertas. claimDue toma las filas con SKIP LOCKED y les corre
 * next_attempt_at (lease), así dos réplicas del worker no envían lo mismo. Si el proceso muere a
 * mitad, la fila vuelve a estar disponible al vencer el lease (entrega "al menos una vez").
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly ports: Map<Channel, ChannelPort>;
  private readonly policy: RetryPolicy;

  constructor(
    private readonly db: Database,
    private readonly notifications: NotificationRepository,
    private readonly subscriptions: PushSubscriptionRepository,
    @Inject(CHANNEL_PORTS) ports: ChannelPort[],
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ports = new Map(ports.map((p) => [p.channel, p]));
    this.policy = {
      maxAttempts: config.notifications.maxAttempts,
      baseSeconds: config.notifications.retryBaseSeconds,
      maxSeconds: config.notifications.retryMaxSeconds,
    };
  }

  /** tenantId limita la pasada a un tenant (tests que comparten la base). */
  async dispatchDue(now = new Date(), limit = 50, tenantId?: string): Promise<DispatchRun> {
    const run: DispatchRun = { sent: 0, retried: 0, failed: 0 };
    const batch = await this.notifications.claimDue(this.db, now, limit, LEASE_SECONDS, tenantId);
    for (const n of batch) {
      const outcome = await this.dispatchOne(n, now);
      run[outcome]++;
    }
    return run;
  }

  private async dispatchOne(n: QueuedNotification, now: Date): Promise<keyof DispatchRun> {
    try {
      const port = this.ports.get(n.channel);
      if (!port) throw new ChannelSendError(`Canal ${n.channel} sin adaptador`, true);
      const { providerMsgId } = await port.send(await this.message(n));
      await this.notifications.markSent(this.db, n.id, providerMsgId, n.attempts + 1, new Date());
      return 'sent';
    } catch (error) {
      const e = error instanceof ChannelSendError ? error : new ChannelSendError(error instanceof Error ? error.message : String(error), false);
      if (e.gone) await this.subscriptions.deleteByEndpoint(this.db, n.recipient);
      const outcome = onFailure(n.attempts, e.permanent, this.policy, now);
      if (outcome.kind === 'retry') {
        await this.notifications.markRetry(this.db, n.id, outcome.attempts, outcome.nextAttemptAt, e.message);
        this.logger.warn(`${n.channel} ${n.templateCode} #${n.id}: intento ${outcome.attempts} falló (${e.message}); reintento ${outcome.nextAttemptAt.toISOString()}`);
        return 'retried';
      }
      await this.notifications.markFailed(this.db, n.id, outcome.attempts, e.message);
      this.logger.error(`${n.channel} ${n.templateCode} #${n.id} falló definitivamente: ${e.message}`);
      return 'failed';
    }
  }

  private async message(n: QueuedNotification): Promise<OutgoingMessage> {
    const p = n.payload as { subject?: string | null; text?: string; html?: string | null; url?: string | null; subscriptionId?: string };
    const message: OutgoingMessage = {
      notificationId: n.id,
      channel: n.channel,
      recipient: n.recipient,
      subject: p.subject ?? null,
      text: p.text ?? '',
      html: p.html ?? null,
      url: p.url ?? null,
    };
    if (n.channel === 'webpush') {
      const sub = p.subscriptionId ? await this.subscriptions.findById(this.db, p.subscriptionId) : null;
      if (!sub || sub.endpoint !== n.recipient) throw new ChannelSendError('La suscripción de Web Push ya no existe', true);
      message.push = { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth };
    }
    return message;
  }
}
