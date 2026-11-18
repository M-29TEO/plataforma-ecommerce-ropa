import { ConflictError, NotFoundError, ValidationError } from '../../../shared-kernel';

export class OrderNotFoundError extends NotFoundError {
  constructor(orderId: string) {
    super('ORDER_NOT_FOUND', 'Pedido no encontrado', { orderId });
  }
}

/** La transición no existe en la máquina de estados o no cumple su condición. */
export class InvalidOrderTransitionError extends ConflictError {
  constructor(from: string, to: string, message: string) {
    super('INVALID_ORDER_TRANSITION', message, { from, to });
  }
}

/** Concurrencia optimista: otro proceso cambió el pedido después de que el cliente lo leyó. */
export class StaleOrderVersionError extends ConflictError {
  constructor(orderId: string, expectedVersion: number, currentVersion?: number) {
    super('STALE_VERSION', 'El pedido fue modificado por otra operación; recarga y reintenta', {
      orderId,
      expectedVersion,
      currentVersion,
    });
  }
}

export class ReasonRequiredError extends ValidationError {
  constructor(to: string) {
    super('REASON_REQUIRED', `Indica el motivo para pasar el pedido a "${to}"`, { to });
  }
}

/** El cliente solo puede cancelar sus pedidos antes de que entren a preparación. */
export class CustomerCannotTransitionError extends ConflictError {
  constructor(from: string, to: string) {
    super('CUSTOMER_TRANSITION_NOT_ALLOWED', 'Solo puedes cancelar un pedido antes de que entre a preparación', {
      from,
      to,
    });
  }
}

export class InvalidOrderError extends ValidationError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

export class ReturnNotFoundError extends NotFoundError {
  constructor(returnId: string) {
    super('RETURN_NOT_FOUND', 'Devolución no encontrada', { returnId });
  }
}

/** El pedido no admite devoluciones (no entregado, fuera de plazo). */
export class ReturnNotAllowedError extends ConflictError {}

/** Solicitud o inspección con datos inválidos (cantidades, motivos, fotos, variantes). */
export class InvalidReturnError extends ValidationError {}

/** La devolución no admite la operación en su estado actual. */
export class InvalidReturnTransitionError extends ConflictError {
  constructor(from: string, to: string) {
    super('INVALID_RETURN_TRANSITION', `Una devolución en estado "${from}" no puede pasar a "${to}"`, { from, to });
  }
}
