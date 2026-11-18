import { createTransport, Transporter } from 'nodemailer';
import { StoreCreditMailer, StoreCreditMessage } from '../application/ports';

function body(m: StoreCreditMessage): { subject: string; lines: string[] } {
  return {
    subject: `Tu saldo a favor por la devolución ${m.rmaNumber}`,
    lines: [
      `Hola, ${m.customerName}:`,
      '',
      `Recibimos tu devolución ${m.rmaNumber} y acreditamos USD ${m.amount} como saldo a favor en una gift card.`,
      `Código: ${m.code}`,
      'Úsalo en el checkout, en "Gift card". Guárdalo: por seguridad no podemos volver a mostrarlo.',
    ],
  };
}

/** SMTP con Nodemailer (Mailpit en desarrollo: smtp://mailpit:1025, bandeja en http://localhost:8025). */
export class SmtpStoreCreditMailer extends StoreCreditMailer {
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

  async send(m: StoreCreditMessage): Promise<void> {
    const { subject, lines } = body(m);
    await this.transport.sendMail({ from: this.from, to: m.to, subject, text: lines.join('\n') });
  }
}

/** En memoria (tests): guarda los mensajes. `failNext` simula una caída del SMTP. */
export class InMemoryStoreCreditMailer extends StoreCreditMailer {
  readonly sent: (StoreCreditMessage & { subject: string; text: string })[] = [];
  failNext = 0;

  async send(m: StoreCreditMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('SMTP no disponible (simulado)');
    }
    const { subject, lines } = body(m);
    this.sent.push({ ...m, subject, text: lines.join('\n') });
  }
}
