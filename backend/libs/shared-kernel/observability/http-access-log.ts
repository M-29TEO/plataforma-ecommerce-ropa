import { Logger } from '@nestjs/common';
import { context } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { currentRequestContext, runWithRequestContext } from './request-context';

const logger = new Logger('HTTP');
/** Healthchecks de Docker y Uptime Kuma: solo se registran si fallan. */
const QUIET_ROUTES = new Set(['/v1/health']);

/**
 * Una línea de log por request al terminar: método, ruta, status y duración, con el request_id y
 * el trace_id del request (va después de requestIdMiddleware).
 *
 * La ruta es la plantilla de Express ('/v1/orders/:id'), nunca la URL real: la URL puede llevar
 * tokens firmados (enlaces de tickets) o ids que no deben quedar en los logs. Sin ruta (404) va 'sin_ruta'.
 */
export function httpAccessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  const reqCtx = currentRequestContext();
  const otelCtx = context.active();
  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const route = (req.route as { path?: string } | undefined)?.path;
    if (route && QUIET_ROUTES.has(route) && res.statusCode < 400) return;
    const entry = {
      msg: `${req.method} ${route ?? 'sin_ruta'} ${res.statusCode} ${durationMs.toFixed(1)}ms`,
      http_method: req.method,
      http_route: route ?? 'sin_ruta',
      http_status: res.statusCode,
      duration_ms: Math.round(durationMs * 10) / 10,
    };
    const write = () => context.with(otelCtx, () => (res.statusCode >= 500 ? logger.error(entry) : logger.log(entry)));
    if (reqCtx) runWithRequestContext(reqCtx, write);
    else write();
  });
  next();
}
