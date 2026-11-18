import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ChannelPort, OutgoingMessage, SendResult } from '../../application/ports';

/** Cuántos mensajes recuerda el simulador (para inspeccionarlos en tests o en una consola). */
const KEEP_LAST = 200;

/**
 * WhatsApp y SMS SIMULADOS (ADR-10 y docs/02-stack-open-source.md): la API oficial de WhatsApp
 * y los SMS siempre tienen costo, así que el adaptador solo registra el mensaje en el log del
 * worker y devuelve un id de proveedor ficticio. El día que haya un proveedor real, se escribe
 * otro ChannelPort con el mismo contrato y no cambia nada más.
 */
export class SimulatedMessagingChannel extends ChannelPort {
  private readonly logger: Logger;
  readonly sent: (OutgoingMessage & { providerMsgId: string })[] = [];

  constructor(readonly channel: 'whatsapp' | 'sms') {
    super();
    this.logger = new Logger(channel === 'whatsapp' ? 'WhatsAppSimulado' : 'SmsSimulado');
  }

  async send(m: OutgoingMessage): Promise<SendResult> {
    const providerMsgId = `sim-${this.channel === 'whatsapp' ? 'wa' : 'sms'}-${randomUUID()}`;
    this.logger.log(`→ ${m.recipient} [${providerMsgId}] ${m.text}`);
    this.sent.push({ ...m, providerMsgId });
    if (this.sent.length > KEEP_LAST) this.sent.splice(0, this.sent.length - KEEP_LAST);
    return { providerMsgId };
  }
}
