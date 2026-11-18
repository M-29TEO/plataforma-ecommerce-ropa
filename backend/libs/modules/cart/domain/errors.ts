import { ConflictError, NotFoundError, ValidationError } from '../../../shared-kernel';

export class CartLimitError extends ValidationError {
  constructor(code: 'CART_QUANTITY_LIMIT' | 'CART_TOO_MANY_LINES' | 'CART_TOO_MANY_COUPONS', message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

export class CartNotFoundError extends NotFoundError {
  constructor(details: Record<string, unknown> = {}) {
    super('CART_NOT_FOUND', 'No hay un carrito activo', details);
  }
}

export class CartItemNotFoundError extends NotFoundError {
  constructor(variantId: string) {
    super('CART_ITEM_NOT_FOUND', 'El producto no está en el carrito', { variantId });
  }
}

export class VariantNotFoundError extends NotFoundError {
  constructor(variantId: string) {
    super('VARIANT_NOT_FOUND', 'El producto no existe', { variantId });
  }
}

export class VariantUnavailableError extends ConflictError {
  constructor(variantId: string) {
    super('VARIANT_UNAVAILABLE', 'El producto ya no está disponible para la venta', { variantId });
  }
}

export class CartInsufficientStockError extends ConflictError {
  constructor(variantId: string, requested: number, available: number) {
    super(
      'INSUFFICIENT_STOCK',
      available > 0 ? `Solo quedan ${available} unidades disponibles` : 'El producto está agotado',
      { variantId, requested, available },
    );
  }
}

/** El código de error es el motivo del motor de promociones (COUPON_NOT_FOUND, NOT_COMBINABLE, ...). */
export class CouponRejectedError extends ValidationError {
  constructor(reason: string, message: string, details: Record<string, unknown>) {
    super(reason, message, details);
  }
}

export class InvalidContactError extends ValidationError {
  constructor(message: string) {
    super('INVALID_CONTACT', message);
  }
}
