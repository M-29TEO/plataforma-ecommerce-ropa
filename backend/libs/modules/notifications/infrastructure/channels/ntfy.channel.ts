import { ChannelPort, ChannelSendError, OutgoingMessage, SendResult } from '../../application/ports';

/**
 * ntfy (Apache 2.0, autoalojado): alertas del backoffice y, más adelante, de la app del
 * motorizado. Se publica en JSON a la raíz del servidor (admite UTF-8 en el título, a
 * diferencia de los headers). El destinatario es el tópico.
 */
export class NtfyChannel extends ChannelPort {
  readonly channel = 'ntfy' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  async send(m: OutgoingMessage): Promise<SendResult> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({ topic: m.recipient, title: m.subject ?? undefined, message: m.text, click: m.url ?? undefined, tags: ['bell'] }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // Bajo Jest el DOMException del abort no es instanceof Error: se usa su name.
      const name = (error as { name?: string })?.name;
      throw new ChannelSendError(`ntfy: ${name === 'TimeoutError' ? 'timeout' : (error as Error)?.message ?? String(error)}`, false);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new ChannelSendError(`ntfy ${res.status}: ${detail}`, res.status >= 400 && res.status < 500 && res.status !== 429);
    }
    const body = (await res.json().catch(() => null)) as { id?: string } | null;
    return { providerMsgId: body?.id ?? null };
  }
}
