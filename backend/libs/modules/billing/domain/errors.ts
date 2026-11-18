import { ConflictError, NotFoundError, ValidationError } from '../../../shared-kernel';

export class InvalidAccessKeyError extends ValidationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_ACCESS_KEY', message, details);
  }
}

/** El pedido no se puede convertir en factura (montos que no cuadran, línea sin datos...). */
export class InvalidInvoiceError extends ValidationError {}

export class InvalidBuyerIdError extends ValidationError {
  constructor(idType: string, idNumber: string, reason: string) {
    super('INVALID_BUYER_ID', `Identificación del comprador inválida: ${reason}`, { idType, idNumber });
  }
}

/** Factura a consumidor final por encima del máximo que permite el SRI. */
export class BuyerIdRequiredError extends ValidationError {
  constructor(total: string, limit: string) {
    super(
      'BILLING_ID_REQUIRED',
      `Para compras de más de USD ${limit} la factura debe llevar cédula, RUC o pasaporte del comprador`,
      { total, limit },
    );
  }
}

/** El tenant no tiene el punto de emisión configurado (billing.emission_points + sequences). */
export class EmissionPointNotConfiguredError extends ConflictError {
  constructor(tenantId: string, establishment: string, emissionPoint: string) {
    super(
      'EMISSION_POINT_NOT_CONFIGURED',
      `No hay un punto de emisión activo ${establishment}-${emissionPoint} con secuencial de facturas`,
      { tenantId, establishment, emissionPoint },
    );
  }
}

export class DocumentNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('DOCUMENT_NOT_FOUND', 'Comprobante electrónico no encontrado', { id });
  }
}

export class DocumentFileNotReadyError extends ConflictError {
  constructor(id: string, file: 'xml' | 'ride') {
    super('DOCUMENT_FILE_NOT_READY', file === 'ride' ? 'El RIDE se genera al autorizarse la factura' : 'El XML todavía no se genera', {
      id,
    });
  }
}

/** El SRI no admite notas de crédito a consumidor final (la factura original no identifica al comprador). */
export class CreditNoteNotAllowedError extends ConflictError {
  constructor(returnId: string) {
    super('CREDIT_NOTE_CONSUMER_FINAL', 'No se emite nota de crédito sobre una factura a consumidor final', { returnId });
  }
}

/** La devolución no tiene factura vigente que modificar (todavía no se emitió o fue anulada). */
export class InvoiceToModifyNotFoundError extends ConflictError {
  constructor(orderId: string) {
    super('INVOICE_TO_MODIFY_NOT_FOUND', 'El pedido no tiene una factura vigente que la nota de crédito pueda modificar', { orderId });
  }
}
