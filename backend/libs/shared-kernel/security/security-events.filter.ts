import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { RequestWithId } from './audit.interceptor';

export type { RequestWithId };

const SECURITY_STATUSES = new Set([401, 403, 413, 429]);

/** Una línea de log por evento de seguridad, sin datos del cliente sin escapar (A09). */
export function logSecurityEvent(logger: Logger, req: RequestWithId, status: number, code: string): void {
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0].slice(0, 200).replace(/[^\x20-\x7e]/g, '?');
  logger.warn(
    JSON.stringify({ event: 'security', status, code, method: req.method, path, ip: req.ip, user: req.user?.id ?? null, requestId: req.requestId }),
  );
}

/**
 * HttpException de Nest (guards, ValidationPipe, throttler): 401, 403, 413 y 429 quedan en el log
 * con IP, usuario y request id (fuerza bruta, sondeo de permisos). La respuesta no cambia.
 */
@Catch(HttpException)
export class SecurityEventsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('Security');

  override catch(exception: HttpException, host: ArgumentsHost): void {
    const status = exception.getStatus();
    if (host.getType() === 'http' && SECURITY_STATUSES.has(status)) {
      logSecurityEvent(this.logger, host.switchToHttp().getRequest<RequestWithId>(), status, exception.name);
    }
    super.catch(exception, host);
  }
}
