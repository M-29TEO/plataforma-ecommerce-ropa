import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { APP_CONFIG, AppConfig, applyHttpHardening, DomainExceptionFilter, httpAccessLogMiddleware, SecurityEventsFilter } from '../../libs/shared-kernel';

/** Configuración HTTP compartida entre main.ts y los tests e2e (misma validación, mismos errores, mismo borde). */
export function configureApp(app: INestApplication): INestApplication {
  applyHttpHardening(app as NestExpressApplication, app.get<AppConfig>(APP_CONFIG).security);
  app.use(httpAccessLogMiddleware);
  // Caddy recibe /api/v1/... y elimina /api (handle_path), así que la app expone /v1/...
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      // Los errores de validación no devuelven el objeto ni el valor recibidos.
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalFilters(new SecurityEventsFilter(app.getHttpAdapter()), new DomainExceptionFilter());
  return app;
}
