import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseError } from 'pg';
import { logSecurityEvent, RequestWithId } from '../security/security-events.filter';
import { DomainError, DomainErrorKind } from './domain-error';

const STATUS_BY_KIND: Record<DomainErrorKind, number> = {
  validation: HttpStatus.UNPROCESSABLE_ENTITY,
  not_found: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  unauthenticated: HttpStatus.UNAUTHORIZED,
  forbidden: HttpStatus.FORBIDDEN,
  locked: HttpStatus.LOCKED,
};

/** Códigos SQLSTATE que tienen sentido para el cliente; el resto es un 500. */
const PG_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  '23503': { status: 422, code: 'REFERENCE_NOT_FOUND', message: 'Una referencia no existe' },
  '23505': { status: 409, code: 'DUPLICATE', message: 'El registro ya existe' },
  '23514': { status: 409, code: 'CONSTRAINT_VIOLATION', message: 'La operación viola una regla de integridad' },
  '22P02': { status: 400, code: 'INVALID_INPUT', message: 'Formato de dato inválido' },
  // Byte nulo u otro carácter que UTF-8/text no admite (p. ej. \u0000 en un JSON): entrada inválida, no un 500.
  '22021': { status: 400, code: 'INVALID_INPUT', message: 'El texto contiene caracteres no válidos' },
  '22P05': { status: 400, code: 'INVALID_INPUT', message: 'El texto contiene caracteres no válidos' },
};

@Catch(DomainError, DatabaseError)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: DomainError | DatabaseError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainError) {
      const status = STATUS_BY_KIND[exception.kind];
      if (status === 401 || status === 403 || status === 423) {
        logSecurityEvent(this.logger, host.switchToHttp().getRequest<RequestWithId>(), status, exception.code);
      }
      res.status(status).json({
        error: { code: exception.code, message: exception.message, details: exception.details },
      });
      return;
    }

    const mapped = exception.code ? PG_ERRORS[exception.code] : undefined;
    if (mapped) {
      // El nombre de la restricción revela el esquema interno: va al log, no al cliente.
      this.logger.warn(`${mapped.code}: ${exception.constraint ?? exception.message}`);
      res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
      return;
    }

    this.logger.error(exception.message, exception.stack);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Error interno' } });
  }
}
