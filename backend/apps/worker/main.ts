import './instrumentation';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createAppLogger } from '../../libs/shared-kernel';
import { WorkerModule } from './worker.module';

/** Proceso worker: sin HTTP, solo consumidores y schedulers de BullMQ. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: createAppLogger('moda-worker') });
  app.enableShutdownHooks();
  Logger.log('Worker iniciado', 'Bootstrap');
}

void bootstrap();
