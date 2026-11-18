import webpush, { WebPushError } from 'web-push';
import { ChannelPort, ChannelSendError, OutgoingMessage, SendResult } from '../../application/ports';
import { isAllowedPushEndpoint } from '../../domain/push-endpoint';

export interface VapidConfig {
  publicKey: string | null;
  privateKey: string | null;
  subject: string;
}

/**
 * Web Push con VAPID (estándar abierto, sin Firebase): la PWA registra su suscripción y el
 * servicio push del navegador entrega el mensaje cifrado. El cuerpo es JSON
 * { title, body, url, tag } y el service worker de la PWA lo muestra.
 */
export class VapidWebPushChannel extends ChannelPort {
  readonly channel = 'webpush' as const;

  constructor(
    private readonly vapid: VapidConfig,
    private readonly timeoutMs: number,
    private readonly allowedHosts: readonly string[],
  ) {
    super();
  }

  async send(m: OutgoingMessage): Promise<SendResult> {
    if (!this.vapid.publicKey || !this.vapid.privateKey) {
      throw new ChannelSendError('Web Push deshabilitado: faltan VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY', true);
    }
    if (!m.push) throw new ChannelSendError('Falta la suscripción de Web Push', true);
    // Defensa en profundidad: una fila anterior a la lista blanca no sale hacia la red interna.
    if (!isAllowedPushEndpoint(m.push.endpoint, this.allowedHosts)) throw new ChannelSendError('Endpoint de Web Push no permitido', true, true);
    const body = JSON.stringify({ title: m.subject ?? '', body: m.text, url: m.url, tag: m.notificationId });
    try {
      const res = await webpush.sendNotification({ endpoint: m.push.endpoint, keys: { p256dh: m.push.p256dh, auth: m.push.auth } }, body, {
        vapidDetails: { subject: this.vapid.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
        TTL: 24 * 3600,
        timeout: this.timeoutMs,
        urgency: 'normal',
      });
      return { providerMsgId: (res.headers?.location as string | undefined) ?? null };
    } catch (error) {
      if (error instanceof WebPushError) {
        // 404/410: el navegador anuló la suscripción. 4xx restantes: payload o claves inválidas.
        const gone = error.statusCode === 404 || error.statusCode === 410;
        const permanent = gone || (error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429);
        // Solo el código: el cuerpo de la respuesta no se guarda (no se refleja contenido de terceros).
        throw new ChannelSendError(`Web Push respondió HTTP ${error.statusCode}`, permanent, gone);
      }
      throw new ChannelSendError(`Web Push: ${error instanceof Error ? error.message : String(error)}`, false);
    }
  }
}
