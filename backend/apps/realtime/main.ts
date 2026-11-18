import './instrumentation';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_CONFIG, AppConfig, createAppLogger } from '../../libs/shared-kernel';
import { RealtimeModule, ValkeyIoAdapter } from './realtime.module';

/** Proceso realtime (ADR-07): Socket.IO en REALTIME_PORT; Caddy enruta /ws/* aquí. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(RealtimeModule, { logger: createAppLogger('moda-realtime') });
  const config = app.get<AppConfig>(APP_CONFIG);
  const adapter = new ValkeyIoAdapter(app, config);
  await adapter.connect();
  app.useWebSocketAdapter(adapter);
  app.enableShutdownHooks();
  await app.listen(config.realtime.port);
  Logger.log(`Realtime escuchando en :${config.realtime.port}${config.realtime.path}`, 'Bootstrap');
}

void bootstrap();
