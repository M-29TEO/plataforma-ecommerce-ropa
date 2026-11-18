import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './audit.interceptor';
import { RateLimitModule } from './rate-limit';

/**
 * Seguridad de la API HTTP (no del worker): rate limiting global con Valkey y auditoría
 * automática de las rutas @Audited(...). El borde (helmet, CORS, límites del cuerpo, trust proxy)
 * lo aplica configureApp. Ver docs/07-seguridad.md.
 */
@Module({
  imports: [RateLimitModule],
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class SecurityModule {}
