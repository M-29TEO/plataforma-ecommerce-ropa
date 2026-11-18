import { INestApplicationContext, Module } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { LogisticsRealtimeModule } from '../../libs/modules/logistics';
import { AppConfig, ConfigModule, DatabaseModule } from '../../libs/shared-kernel';
import { StaffGateway } from './staff.gateway';
import { TrackingGateway } from './tracking.gateway';

/**
 * Proceso realtime: gateway de tracking público (namespace /) y del backoffice (namespace /staff,
 * JWT de acceso). Sin controladores HTTP ni otros módulos.
 */
@Module({
  imports: [ConfigModule.forRoot(), DatabaseModule, LogisticsRealtimeModule],
  providers: [TrackingGateway, StaffGateway],
})
export class RealtimeModule {}

/**
 * Socket.IO con el adaptador de Valkey: lo que la API publica con @socket.io/redis-emitter llega a
 * los clientes de cualquier instancia. Mismo origen que el storefront (Caddy), así que sin CORS.
 */
export class ValkeyIoAdapter extends IoAdapter {
  private pub?: Redis;
  private sub?: Redis;

  constructor(
    app: INestApplicationContext,
    private readonly config: AppConfig,
  ) {
    super(app);
  }

  async connect(): Promise<void> {
    this.pub = new Redis(this.config.valkeyUrl, { lazyConnect: true });
    this.sub = this.pub.duplicate();
    await Promise.all([this.pub.connect(), this.sub.connect()]);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, {
      ...options,
      path: this.config.realtime.path,
      cors: { origin: false },
      serveClient: false,
      // Solo recibe un token en el handshake (el JWT de acceso del staff, con sus permisos, puede
      // pasar de 4 KB): sin mensajes grandes.
      maxHttpBufferSize: 16 * 1024,
    });
    if (this.pub && this.sub) server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }

  override async close(server: Server): Promise<void> {
    await super.close(server);
    this.pub?.disconnect();
    this.sub?.disconnect();
  }
}
