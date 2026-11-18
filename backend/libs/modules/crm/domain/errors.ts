import { ConflictError, NotFoundError, ValidationError } from '../../../shared-kernel';

export class InvalidAddressError extends ValidationError {
  constructor(message: string, field?: string) {
    super('INVALID_ADDRESS', message, field ? { field } : undefined);
  }
}

export class AddressNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('ADDRESS_NOT_FOUND', 'La dirección no existe', { id });
  }
}

export class AddressLimitError extends ConflictError {
  constructor(max: number) {
    super('ADDRESS_LIMIT_REACHED', `Puedes guardar hasta ${max} direcciones; elimina una para agregar otra`, { max });
  }
}

/** El pin manual cae fuera de Ecuador (continente y Galápagos). */
export class LocationOutOfCoverageError extends ValidationError {
  constructor(lat: number, lng: number) {
    super('LOCATION_OUT_OF_COUNTRY', 'El punto marcado está fuera de Ecuador', { lat, lng });
  }
}

/** Checkout con una dirección guardada sin ubicación: hay que marcarla en el mapa. */
export class AddressWithoutLocationError extends ValidationError {
  constructor(id: string) {
    super('ADDRESS_NEEDS_PIN', 'La dirección no tiene ubicación: márcala en el mapa', { id });
  }
}

export class WishlistLimitError extends ConflictError {
  constructor(max: number) {
    super('WISHLIST_LIMIT_REACHED', `Tu lista de deseos admite hasta ${max} productos`, { max });
  }
}

export class WishlistItemNotFoundError extends NotFoundError {
  constructor(productId: string) {
    super('WISHLIST_ITEM_NOT_FOUND', 'El producto no está en tu lista de deseos', { productId });
  }
}

export class ProductNotFoundError extends NotFoundError {
  constructor(productId: string) {
    super('PRODUCT_NOT_FOUND', 'El producto no existe', { productId });
  }
}

export class InvalidWishlistVariantError extends ValidationError {
  constructor(variantId: string) {
    super('INVALID_WISHLIST_VARIANT', 'La talla o color elegido no pertenece a este producto', { variantId });
  }
}

export class InvalidTierError extends ValidationError {
  constructor(message: string, field?: string) {
    super('INVALID_TIER', message, field ? { field } : undefined);
  }
}

export class TierNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('TIER_NOT_FOUND', 'El nivel no existe', { id });
  }
}

export class TierConflictError extends ConflictError {
  constructor(field: 'name' | 'minPoints') {
    super('TIER_CONFLICT', field === 'name' ? 'Ya existe un nivel con ese nombre' : 'Ya existe un nivel con ese mínimo de puntos', { field });
  }
}

/** Saldo insuficiente para un canje o un ajuste negativo. */
export class InsufficientPointsError extends ConflictError {
  constructor(balance: number, requested: number) {
    super('INSUFFICIENT_POINTS', `Tienes ${balance} puntos disponibles; se necesitan ${requested}`, { balance, requested });
  }
}

export class InvalidRedemptionError extends ValidationError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

export class InvalidAdjustmentError extends ValidationError {
  constructor(message: string) {
    super('INVALID_ADJUSTMENT', message);
  }
}

export class LoyaltyAccountNotFoundError extends NotFoundError {
  constructor(userId: string) {
    super('LOYALTY_ACCOUNT_NOT_FOUND', 'El cliente no tiene cuenta de puntos', { userId });
  }
}

export class ReferralCodeNotFoundError extends NotFoundError {
  constructor() {
    super('REFERRAL_CODE_NOT_FOUND', 'El código de referido no existe');
  }
}

/** Motivos por los que no se acepta un código de referido. */
export class ReferralNotAllowedError extends ConflictError {
  constructor(reason: 'SELF_REFERRAL' | 'ALREADY_REFERRED' | 'HAS_ORDERS' | 'NOT_A_CUSTOMER') {
    const messages = {
      SELF_REFERRAL: 'No puedes usar tu propio código',
      ALREADY_REFERRED: 'Ya aplicaste un código de referido',
      HAS_ORDERS: 'El código de referido es solo para clientes que aún no han comprado',
      NOT_A_CUSTOMER: 'Solo los clientes pueden usar códigos de referido',
    } as const;
    super('REFERRAL_NOT_ALLOWED', messages[reason], { reason });
  }
}

export class TierInUseError extends ConflictError {
  constructor(accounts: number) {
    super('TIER_IN_USE', `El nivel tiene ${accounts} clientes; edítalo en lugar de borrarlo`, { accounts });
  }
}
