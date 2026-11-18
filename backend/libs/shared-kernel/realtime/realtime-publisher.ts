import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/**
 * Publica eventos a las salas de Socket.IO del proceso realtime (ADR-07) sin tener sockets: la API y
 * el worker escriben en Valkey con el protocolo del adaptador (@socket.io/redis-emitter) y cada
 * instancia de realtime los entrega a sus clientes conectados. Salas: `order:{id}` y `rider:{id}` en el
 * namespace por defecto, y `riders:{tenantId}` en el namespace `/staff` (backoffice).
 *
 * Es "mejor esfuerzo": el estado durable está en PostgreSQL y el cliente lo relee por HTTP al
 * reconectarse, así que un evento perdido (Valkey caído) no se reintenta ni rompe la operación.
 */
export abstract class RealtimePublisher {
  /** namespace: por defecto `/` (clientes públicos); `/staff` para el backoffice. */
  abstract publish(room: string, event: string, data: Record<string, unknown>, namespace?: string): void;
}

@Injectable()
export class ValkeyRealtimePublisher extends RealtimePublisher implements OnModuleDestroy {
  private readonly logger = new Logger(ValkeyRealtimePublisher.name);
  private readonly redis: Redis;
  private readonly emitter: Emitter;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.redis = new Redis(config.valkeyUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    this.redis.on('error', () => undefined);
    this.emitter = new Emitter(this.redis);
  }

  publish(room: string, event: string, data: Record<string, unknown>, namespace = '/'): void {
    try {
      (namespace === '/' ? this.emitter : this.emitter.of(namespace)).to(room).emit(event, data);
    } catch (error) {
      this.logger.warn(`No se pudo publicar ${event} en ${room}: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}

/** Para tests: guarda lo publicado. */
@Injectable()
export class MemoryRealtimePublisher extends RealtimePublisher {
  readonly published: Array<{ room: string; event: string; data: Record<string, unknown>; namespace: string }> = [];

  publish(room: string, event: string, data: Record<string, unknown>, namespace = '/'): void {
    this.published.push({ room, event, data, namespace });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: RealtimePublisher,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => (c.realtime.transport === 'memory' ? new MemoryRealtimePublisher() : new ValkeyRealtimePublisher(c)),
    },
  ],
  exports: [RealtimePublisher],
})
export class RealtimePublisherModule {}
