import { Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { orderRoom, TrackingTokenResolver } from '../../libs/modules/logistics';

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Tracking en vivo (ADR-07). El cliente se conecta con el token público de seguimiento en el
 * handshake (`io({ path: '/ws/socket.io', auth: { trackingToken } })`) y queda en la sala
 * `order:{id}` de su pedido. No recibe nada más: los eventos (`rider.location`,
 * `shipment.status`) los publican la API y el worker por Valkey (RealtimePublisher) y el
 * adaptador los reparte entre las instancias de este proceso.
 *
 * Solo lectura: el cliente no puede emitir a la sala (no hay @SubscribeMessage). Un token
 * inválido recibe `tracking.error` y se desconecta.
 */
@WebSocketGateway()
export class TrackingGateway implements OnGatewayConnection {
  private readonly logger = new Logger(TrackingGateway.name);

  constructor(private readonly resolver: TrackingTokenResolver) {}

  async handleConnection(socket: Socket): Promise<void> {
    const raw = (socket.handshake.auth as { trackingToken?: unknown } | undefined)?.trackingToken;
    const token = typeof raw === 'string' && TOKEN.test(raw) ? raw : null;
    try {
      const tracking = token ? await this.resolver.resolve(token) : null;
      if (!tracking) {
        socket.emit('tracking.error', { code: 'TRACKING_NOT_FOUND', message: 'El enlace de seguimiento no existe' });
        socket.disconnect(true);
        return;
      }
      await socket.join(orderRoom(tracking.orderId));
      socket.emit('tracking.ready', { shipmentId: tracking.shipmentId, status: tracking.status });
    } catch (error) {
      this.logger.error(`No se pudo suscribir al tracking: ${(error as Error).message}`);
      socket.emit('tracking.error', { code: 'INTERNAL', message: 'Intenta de nuevo en unos segundos' });
      socket.disconnect(true);
    }
  }
}
