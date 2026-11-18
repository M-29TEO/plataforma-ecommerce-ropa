import { createTransport, Transporter } from 'nodemailer';
import { ChannelPort, ChannelSendError, OutgoingMessage, SendResult } from '../../application/ports';

/** Error SMTP con código de respuesta (Nodemailer): 5xx es permanente (buzón inexistente, rechazo). */
function isPermanentSmtp(error: unknown): boolean {
  const code = (error as { responseCode?: unknown })?.responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
}

/** Email con Nodemailer por SMTP (Mailpit en desarrollo: smtp://mailpit:1025, bandeja en http://localhost:8025). */
export class SmtpEmailChannel extends ChannelPort {
  readonly channel = 'email' as const;
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
    timeoutMs: number,
  ) {
    super();
    const u = new URL(smtpUrl);
    this.transport = createTransport({
      host: u.hostname,
      port: Number(u.port || (u.protocol === 'smtps:' ? 465 : 25)),
      secure: u.protocol === 'smtps:',
      auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs * 2,
    });
  }

  async send(m: OutgoingMessage): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to: m.recipient,
        subject: m.subject ?? '',
        text: m.text,
        html: m.html ?? undefined,
        headers: { 'X-Notification-Id': m.notificationId },
      });
      return { providerMsgId: info.messageId ?? null };
    } catch (error) {
      throw new ChannelSendError(`SMTP: ${error instanceof Error ? error.message : String(error)}`, isPermanentSmtp(error));
    }
  }
}
