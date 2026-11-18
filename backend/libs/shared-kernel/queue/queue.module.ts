import { Global, Module } from '@nestjs/common';
import type { ConnectionOptions } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');

/** Convierte VALKEY_URL (redis://[:password@]host:port[/db]) en opciones de conexión de BullMQ. */
export function connectionFromUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null, // requerido por los Worker de BullMQ
  };
}

@Global()
@Module({
  providers: [
    { provide: QUEUE_CONNECTION, inject: [APP_CONFIG], useFactory: (c: AppConfig) => connectionFromUrl(c.valkeyUrl) },
  ],
  exports: [QUEUE_CONNECTION],
})
export class QueueModule {}
