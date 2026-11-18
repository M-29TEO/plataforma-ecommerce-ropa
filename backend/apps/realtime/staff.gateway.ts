import { Inject, Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { ridersRoom, STAFF_NAMESPACE } from '../../libs/modules/logistics';
import { APP_CONFIG, AppConfig } from '../../libs/shared-kernel';
import { authorizeStaffSocket } from './staff-auth';

/** setTimeout acepta hasta ~24,8 días; un access token dura 15 min. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Backoffice en vivo (mapa de motorizados y despacho). El cliente se conecta al namespace
 * `/staff` con su JWT de acceso:
 *   io('/staff', { path: '/ws/socket.io', auth: { accessToken } })
 * Debe ser staff con logistics.read; queda en la sala `riders:{tenantId}` de su tenant y recibe
 * `rider.location`, `shipment.status` y `rider.presence` (los publica la API por Valkey con
 * RealtimePublisher). Recibe `staff.ready` al unirse.
 *
 * Token inválido o sin permiso → `staff.error` { code } y desconexión. Cuando el token vence se
 * emite `staff.error` { code: 'TOKEN_EXPIRED' } y se desconecta: el cliente renueva el access
 * token (POST /v1/auth/refresh) y se reconecta con el nuevo (socket.auth = { accessToken }; socket.connect()).
 * Solo lectura: no hay @SubscribeMessage.
 */
@WebSocketGateway({ namespace: STAFF_NAMESPACE })
export class StaffGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(StaffGateway.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async handleConnection(socket: Socket): Promise<void> {
    const auth = authorizeStaffSocket((socket.handshake.auth as { accessToken?: unknown } | undefined)?.accessToken, this.config.jwtSecret);
    if (!auth.ok) {
      socket.emit('staff.error', { code: auth.code, message: auth.message });
      socket.disconnect(true);
      return;
    }
    try {
      await socket.join(ridersRoom(auth.tenantId));
    } catch (error) {
      this.logger.error(`No se pudo unir al staff a la sala: ${(error as Error).message}`);
      socket.emit('staff.error', { code: 'INTERNAL', message: 'Intenta de nuevo en unos segundos' });
      socket.disconnect(true);
      return;
    }
    if (auth.expiresAt) {
      const ms = Math.min(Math.max(auth.expiresAt.getTime() - Date.now(), 0), MAX_TIMER_MS);
      const timer = setTimeout(() => {
        socket.emit('staff.error', { code: 'TOKEN_EXPIRED', message: 'La sesión expiró: renueva el token y reconéctate' });
        socket.disconnect(true);
      }, ms);
      timer.unref();
      this.timers.set(socket.id, timer);
    }
    socket.emit('staff.ready', { tenantId: auth.tenantId, expiresAt: auth.expiresAt?.toISOString() ?? null });
  }

  handleDisconnect(socket: Socket): void {
    const timer = this.timers.get(socket.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(socket.id);
  }
}
