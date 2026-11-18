import { ConflictError, NotFoundError, ValidationError } from '../../../shared-kernel';

export class ZoneNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('ZONE_NOT_FOUND', 'La zona de cobertura no existe', { id });
  }
}

export class SlotTemplateNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('SLOT_TEMPLATE_NOT_FOUND', 'La plantilla de franja no existe', { id });
  }
}

export class SlotNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('SLOT_NOT_FOUND', 'La franja no existe en esta zona', { id });
  }
}

/** Otro cliente tomó el último cupo, o la franja cerró mientras se pagaba. */
export class SlotUnavailableError extends ConflictError {
  constructor(id: string, reason: 'full' | 'closed') {
    super(
      'SLOT_UNAVAILABLE',
      reason === 'full' ? 'La franja se llenó; elige otra' : 'La franja ya cerró; elige otra',
      { slotId: id, reason },
    );
  }
}

export class SlotCapacityBelowBookedError extends ConflictError {
  constructor(booked: number) {
    super('SLOT_CAPACITY_BELOW_BOOKED', `La franja ya tiene ${booked} reservas: la capacidad no puede ser menor`, { booked });
  }
}

export class WarehouseUnavailableError extends ValidationError {
  constructor(id: string | null) {
    super('SERVING_WAREHOUSE_UNAVAILABLE', 'La bodega de la zona no existe, está inactiva o no despacha online', { warehouseId: id });
  }
}

export class NoDeliveryCoverageError extends ValidationError {
  constructor(details: Record<string, unknown>) {
    super('NO_DELIVERY_COVERAGE', 'No hay motorizado ni courier que entregue en esa dirección', details);
  }
}

export class DeliveryQuoteInvalidError extends ValidationError {
  constructor() {
    super('INVALID_DELIVERY_QUOTE', 'La cotización de envío no es válida; vuelve a cotizar');
  }
}

export class DeliveryQuoteExpiredError extends ConflictError {
  constructor() {
    super('DELIVERY_QUOTE_EXPIRED', 'La cotización de envío venció; vuelve a cotizar');
  }
}

/** Cambió el carrito, la dirección o el tipo de entrega después de cotizar. */
export class DeliveryQuoteMismatchError extends ConflictError {
  constructor(field: string) {
    super('DELIVERY_QUOTE_MISMATCH', 'El pedido cambió desde que se cotizó el envío; vuelve a cotizar', { field });
  }
}

export class DeliverySlotRequiredError extends ValidationError {
  constructor() {
    super('DELIVERY_SLOT_REQUIRED', 'Elige una franja horaria para la entrega con motorizado');
  }
}

export class ShipmentNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('SHIPMENT_NOT_FOUND', 'El envío no existe', { id });
  }
}

export class RiderNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('RIDER_NOT_FOUND', 'El motorizado no existe', { id });
  }
}

export class AlreadyRatedError extends ConflictError {
  constructor(shipmentId: string) {
    super('ALREADY_RATED', 'Esta entrega ya fue calificada', { shipmentId });
  }
}

/** Pedido de invitado: no hay usuario al que asignar la calificación. */
export class CustomerNotRateableError extends ValidationError {
  constructor(shipmentId: string) {
    super('CUSTOMER_NOT_RATEABLE', 'El pedido es de un invitado: no hay cliente que calificar', { shipmentId });
  }
}

export class SettlementNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('SETTLEMENT_NOT_FOUND', 'La liquidación no existe', { id });
  }
}
