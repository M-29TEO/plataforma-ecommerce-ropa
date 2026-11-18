import { randomUUID } from 'node:crypto';
import { ChannelPort, ChannelSendError, OutgoingMessage, SendResult } from '../../application/ports';
import { Channel } from '../../domain/channel';

/**
 * Canal en memoria (NOTIFICATION_TRANSPORT=memory, tests): guarda lo enviado. Con `failNext`
 * simula caídas: 'transient' (SMTP caído, 5xx), 'permanent' (4xx) o 'gone' (Web Push 404/410).
 */
export class InMemoryChannel extends ChannelPort {
  readonly sent: OutgoingMessage[] = [];
  failNext: ('transient' | 'permanent' | 'gone')[] = [];

  constructor(readonly channel: Channel) {
    super();
  }

  async send(m: OutgoingMessage): Promise<SendResult> {
    const failure = this.failNext.shift();
    if (failure === 'transient') throw new ChannelSendError(`${this.channel} no disponible (simulado)`, false);
    if (failure === 'permanent') throw new ChannelSendError(`${this.channel} rechazó el mensaje (simulado)`, true);
    if (failure === 'gone') throw new ChannelSendError('Web Push 410: suscripción vencida (simulado)', true, true);
    this.sent.push(m);
    return { providerMsgId: `mem-${randomUUID()}` };
  }

  clear(): void {
    this.sent.length = 0;
    this.failNext = [];
  }
}
