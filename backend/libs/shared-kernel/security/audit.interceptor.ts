import { randomUUID } from 'node:crypto';
import { CallHandler, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { from, Observable, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { AuditLog } from '../audit/audit-log';
import { AuthenticatedRequest } from '../auth/guards';
import { TENANT_HEADER } from '../auth/decorators';
import { Database } from '../database/database';
import { DomainError } from '../errors/domain-error';
import { runWithRequestContext } from '../observability/request-context';

export const AUDITED_KEY = 'audited_action';

export interface AuditedOptions {
  /** Tipo de entidad en platform.audit_log ('payment', 'stock', 'role'...). */
  entity: string;
  /** Parámetro de ruta con el id de la entidad. Sin él (o si no viene), se usa result.id. */
  idParam?: string;
  /** false: no guardar el cuerpo (p. ej. uploads); por defecto se guarda redactado. */
  body?: boolean;
}

/**
 * Marca una ruta como acción sensible: el AuditInterceptor global deja una fila en
 * platform.audit_log con actor, IP, request id, entidad, parámetros y cuerpo redactado, tanto si
 * la acción se completa (outcome 'ok') como si se rechaza (outcome 'denied' / 'failed' + código).
 * Ejemplo: @Audited('payments.transfer.approve', { entity: 'payment' })
 */
export const Audited = (action: string, options: AuditedOptions) => SetMetadata(AUDITED_KEY, { action, ...options });

type AuditedMeta = AuditedOptions & { action: string };

/** Claves que nunca se guardan en la auditoría (credenciales y secretos). */
const SECRET_KEY = /pass(word)?|secret|token|^code$|otp|totp|cvv|card|pan|p256dh|^auth$|signature|voucher/i;
const MAX_STRING = 500;
const MAX_DEPTH = 4;

/** Copia acotada del cuerpo: sin secretos, strings truncados, profundidad y arrays limitados. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redactado]' : redact(v, depth + 1);
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export type RequestWithId = AuthenticatedRequest & { requestId?: string };

/**
 * X-Request-Id: se respeta el de Caddy si es seguro de registrar; si no, uno nuevo. Va en la respuesta
 * y en el contexto del request, de donde lo toman los logs (JsonLogger) y el span HTTP.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
  (req as RequestWithId).requestId = id;
  res.setHeader('X-Request-Id', id);
  runWithRequestContext({ requestId: id, req: req as RequestWithId }, next);
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit');

  constructor(
    private readonly reflector: Reflector,
    private readonly db: Database,
    private readonly audit: AuditLog,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditedMeta | undefined>(AUDITED_KEY, context.getHandler());
    if (!meta || context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<RequestWithId>();

    return next.handle().pipe(
      mergeMap((result) => from(this.write(req, meta, 'ok', result).then(() => result))),
      catchError((error: unknown) =>
        from(this.write(req, meta, outcomeOf(error), undefined, error)).pipe(mergeMap(() => throwError(() => error))),
      ),
    );
  }

  private async write(req: RequestWithId, meta: AuditedMeta, outcome: string, result?: unknown, error?: unknown): Promise<void> {
    const tenantId = req.user?.tenantId ?? tenantHeader(req);
    if (!tenantId) return; // sin tenant no hay a quién atribuirlo (audit_log.tenant_id es NOT NULL)
    const params = (req.params ?? {}) as Record<string, string>;
    const resultId = result && typeof result === 'object' && 'id' in result ? String((result as { id: unknown }).id) : undefined;
    const entityId = (meta.idParam ? params[meta.idParam] : params.id) ?? resultId ?? '-';
    const after: Record<string, unknown> = { outcome, method: req.method, path: req.route?.path ?? req.path, params };
    if (meta.body !== false && req.body && Object.keys(req.body).length > 0) after.body = redact(req.body);
    if (error) after.error = errorCode(error);
    try {
      await this.audit.record(this.db, {
        tenantId,
        actorId: req.user?.id ?? null,
        actorType: req.user?.type ?? 'anonymous',
        actorIp: req.ip ?? null,
        action: meta.action,
        entityType: meta.entity,
        entityId,
        after,
        requestId: req.requestId ?? null,
      });
    } catch (e) {
      // La acción ya ocurrió: no se le cambia la respuesta al cliente, pero queda en el log.
      this.logger.error(`No se pudo auditar ${meta.action} (${req.requestId}): ${(e as Error).message}`);
    }
  }
}

function tenantHeader(req: Request): string | null {
  const raw = req.headers[TENANT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && UUID_RE.test(value) ? value.toLowerCase() : null;
}

function outcomeOf(error: unknown): string {
  const status = error instanceof HttpException ? error.getStatus() : error instanceof DomainError ? kindStatus(error) : 500;
  return status === 401 || status === 403 ? 'denied' : 'failed';
}

function kindStatus(e: DomainError): number {
  return e.kind === 'unauthenticated' ? 401 : e.kind === 'forbidden' ? 403 : 422;
}

function errorCode(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  if (error instanceof HttpException) return `HTTP_${error.getStatus()}`;
  return 'INTERNAL';
}
