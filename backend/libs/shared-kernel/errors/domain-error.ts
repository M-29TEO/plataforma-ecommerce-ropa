/**
 * Errores de negocio. El dominio y la capa de aplicación lanzan estos errores sin saber
 * nada de HTTP; el DomainExceptionFilter los traduce a códigos de estado.
 */
export type DomainErrorKind = 'validation' | 'not_found' | 'conflict' | 'unauthenticated' | 'forbidden' | 'locked';

export abstract class DomainError extends Error {
  abstract readonly kind: DomainErrorKind;

  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly kind = 'validation' as const;
}

export class NotFoundError extends DomainError {
  readonly kind = 'not_found' as const;
}

export class ConflictError extends DomainError {
  readonly kind = 'conflict' as const;
}

/** Credenciales inválidas o sesión que ya no vale (401). */
export class UnauthenticatedError extends DomainError {
  readonly kind = 'unauthenticated' as const;
}

/** Autenticado, pero la regla de negocio no le permite la operación (403). */
export class ForbiddenError extends DomainError {
  readonly kind = 'forbidden' as const;
}

/** El recurso está bloqueado temporalmente, p. ej. una cuenta tras varios logins fallidos (423). */
export class LockedError extends DomainError {
  readonly kind = 'locked' as const;
}
