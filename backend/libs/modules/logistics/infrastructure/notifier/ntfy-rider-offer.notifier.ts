import { Logger } from '@nestjs/common';
import { OfferNotification, RiderOfferNotifier } from '../../application/rider-app-ports';

/** Mensaje de ntfy de una oferta. SIN datos del cliente: cualquiera que adivine el tópico lo lee. */
export function offerMessage(n: OfferNotification) {
  return {
    topic: n.topic,
    title: 'Nueva oferta de entrega',
    message: `Tienes ${n.ttlSeconds} s para aceptarla`,
    tags: ['motor_scooter'],
    priority: 5,
    click: 'modarider://ofertas',
  };
}

/**
 * ntfy autoalojado (como NtfyChannel de Notificaciones): JSON a la raíz del servidor, con token si
 * el servidor lo exige. La app del motorizado está suscrita a su tópico (riders.ntfy_topic). Es
 * mejor esfuerzo: si ntfy no responde, la app igual ve la oferta al consultar GET /rider/offers
 * (POST /rider/location devuelve cuántas tiene abiertas).
 */
export class NtfyRiderOfferNotifier extends RiderOfferNotifier {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null,
    private readonly timeoutMs = 5_000,
  ) {
    super();
  }

  async notifyOffer(n: OfferNotification): Promise<void> {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(offerMessage(n)),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
}

/** Tests: guarda los mensajes que se habrían publicado. */
export class InMemoryRiderOfferNotifier extends RiderOfferNotifier {
  private readonly logger = new Logger(InMemoryRiderOfferNotifier.name);
  readonly sent: Array<ReturnType<typeof offerMessage>> = [];

  async notifyOffer(n: OfferNotification): Promise<void> {
    this.sent.push(offerMessage(n));
    this.logger.debug(`Oferta notificada en memoria al tópico ${n.topic}`);
  }
}
