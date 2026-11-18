import { createTransport, Transporter } from 'nodemailer';
import { InvoiceMailer, MailMessage } from '../../application/ports';

/** SMTP con Nodemailer (Mailpit en desarrollo: smtp://mailpit:1025, bandeja en http://localhost:8025). */
export class SmtpInvoiceMailer extends InvoiceMailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    super();
    const u = new URL(smtpUrl);
    this.transport = createTransport({
      host: u.hostname,
      port: Number(u.port || (u.protocol === 'smtps:' ? 465 : 25)),
      secure: u.protocol === 'smtps:',
      auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(m: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html,
      attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
  }
}

/** En memoria (tests): guarda los correos enviados. `failNext` simula una caída del SMTP. */
export class InMemoryInvoiceMailer extends InvoiceMailer {
  readonly sent: MailMessage[] = [];
  failNext = 0;

  async send(m: MailMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('SMTP no disponible (simulado)');
    }
    this.sent.push(m);
  }
}
