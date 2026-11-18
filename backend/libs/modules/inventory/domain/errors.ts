import { ConflictError, NotFoundError, ValidationError } from '../../../shared-kernel';

export class WarehouseNotFoundError extends NotFoundError {
  constructor(warehouseId: string) {
    super('WAREHOUSE_NOT_FOUND', 'Bodega no encontrada', { warehouseId });
  }
}

export class WarehouseInactiveError extends ConflictError {
  constructor(warehouseIds: string[]) {
    super('WAREHOUSE_INACTIVE', 'La bodega no existe o está inactiva para operar stock', { warehouseIds });
  }
}

export class StockLevelNotFoundError extends NotFoundError {
  constructor(variantId: string, warehouseId: string) {
    super('STOCK_LEVEL_NOT_FOUND', 'No hay registro de stock para la variante en esa bodega', { variantId, warehouseId });
  }
}

/** Una línea no pudo reservarse: la reserva completa se revierte. */
export class InsufficientStockError extends ConflictError {
  constructor(variantId: string, warehouseId: string, requested: number) {
    super('INSUFFICIENT_STOCK', 'Stock insuficiente para reservar', { variantId, warehouseId, requested });
  }
}

export class ReservationNotFoundError extends NotFoundError {
  constructor(orderId: string) {
    super('RESERVATION_NOT_FOUND', 'El pedido no tiene reservas activas', { orderId });
  }
}

export class OrderAlreadyReservedError extends ConflictError {
  constructor(orderId: string) {
    super('ORDER_ALREADY_RESERVED', 'El pedido ya tiene reservas activas con otras líneas; libéralas primero', {
      orderId,
    });
  }
}

export class ReservationExpiredError extends ConflictError {
  constructor(orderId: string) {
    super('RESERVATION_EXPIRED', 'La reserva del pedido venció; hay que reservar de nuevo', { orderId });
  }
}

export class StaleStockVersionError extends ConflictError {
  constructor(variantId: string, warehouseId: string, expectedVersion: number) {
    super('STALE_VERSION', 'El stock fue modificado por otra operación; recarga y reintenta', {
      variantId,
      warehouseId,
      expectedVersion,
    });
  }
}

export class AdjustmentBelowReservedError extends ConflictError {
  constructor(details: { onHand: number; reserved: number; delta: number }) {
    super('ADJUSTMENT_BELOW_RESERVED', 'El ajuste dejaría menos unidades físicas que las reservadas', details);
  }
}

export class InvalidAdjustmentError extends ValidationError {
  constructor(message: string) {
    super('INVALID_ADJUSTMENT', message);
  }
}

export class SupplierNotFoundError extends NotFoundError {
  constructor(supplierId: string) {
    super('SUPPLIER_NOT_FOUND', 'El proveedor no existe o está inactivo', { supplierId });
  }
}

export class PurchaseOrderNotFoundError extends NotFoundError {
  constructor(purchaseOrderId: string) {
    super('PURCHASE_ORDER_NOT_FOUND', 'La orden de compra no existe', { purchaseOrderId });
  }
}

export class InvalidPurchaseOrderTransitionError extends ConflictError {
  constructor(from: string, action: string) {
    super('INVALID_PO_TRANSITION', `No se puede ${action} una orden de compra en estado "${from}"`, { from, action });
  }
}

export class OverReceiptError extends ValidationError {
  constructor(itemId: string, pending: number, requested: number) {
    super('OVER_RECEIPT', `Se intenta recibir ${requested} pero faltan ${pending}`, { itemId, pending, requested });
  }
}

/**
 * La variante no existe en el catálogo del tenant. product_variants no tiene tenant_id (solo la FK),
 * así que sin esta verificación se podía operar stock de la variante de otra tienda.
 */
export class VariantNotFoundError extends NotFoundError {
  constructor(variantIds: string[]) {
    super('VARIANT_NOT_FOUND', 'La variante no existe en el catálogo', { variantIds });
  }
}
