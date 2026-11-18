import './instrumentation';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createAppLogger, loadConfig } from '../../libs/shared-kernel';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap(): Promise<void> {
  // rawBody: los webhooks verifican la firma HMAC sobre el cuerpo tal como llegó.
  const app = configureApp(await NestFactory.create(AppModule, { rawBody: true, logger: createAppLogger('moda-api') }));
  app.enableShutdownHooks();
  const { port, iam, security } = loadConfig();
  if (security.dataEncryptionKeyDerived) {
    Logger.warn('DATA_ENCRYPTION_KEY no está definida: la clave de los campos *_enc se deriva de JWT_SECRET (solo para desarrollo)', 'Bootstrap');
  }
  if (iam.mfaEncryptionKeyDerived) {
    Logger.warn('MFA_ENCRYPTION_KEY no está definida: la clave del 2FA se deriva de JWT_SECRET (solo para desarrollo)', 'Bootstrap');
  }
  await app.listen(port);
  Logger.log(`API escuchando en http://localhost:${port}/v1`, 'Bootstrap');
}

void bootstrap();
