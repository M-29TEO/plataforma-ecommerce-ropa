import { ConflictError, NotFoundError, ValidationError } from '../../../shared-kernel';

export class InvalidPromotionError extends ValidationError {
  constructor(message: string, field: string) {
    super('INVALID_PROMOTION', message, { field });
  }
}

export class PromotionNotFoundError extends NotFoundError {
  constructor(promotionId: string) {
    super('PROMOTION_NOT_FOUND', 'Promoción no encontrada', { promotionId });
  }
}

export class InvalidCouponCodeError extends ValidationError {
  constructor(code: string) {
    super('INVALID_COUPON_CODE', 'El código de cupón debe tener de 3 a 40 letras, números, "-" o "_"', { code });
  }
}

/** Canje en checkout: alguna regla de uso ya no se cumple (otro pedido tomó el último cupo, etc.). */
export class RedemptionRejectedError extends ConflictError {
  constructor(reason: string, message: string, details: Record<string, unknown>) {
    super(reason, message, details);
  }
}

export class CustomerIdentityRequiredError extends ValidationError {
  constructor() {
    super('CUSTOMER_IDENTITY_REQUIRED', 'El canje requiere el usuario o el email del cliente');
  }
}

export class GiftCardNotFoundError extends NotFoundError {
  constructor(details: Record<string, unknown> = {}) {
    super('GIFT_CARD_NOT_FOUND', 'Gift card no encontrada', details);
  }
}

/** La gift card no puede usarse: bloqueada, vencida, pendiente de activación o sin saldo. */
export class GiftCardNotUsableError extends ConflictError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}

export class GiftCardInsufficientBalanceError extends ConflictError {
  constructor(balance: string, requested: string) {
    super('GIFT_CARD_INSUFFICIENT_BALANCE', 'La gift card no tiene saldo suficiente', { balance, requested });
  }
}

export class InvalidGiftCardOperationError extends ValidationError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}
