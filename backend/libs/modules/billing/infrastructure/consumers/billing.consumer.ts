import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventBus } from '../../../../shared-kernel';
import { ORDER_PAID } from '../../../orders';
import type { OrderPaidPayload } from '../../../orders';
import { REFUND_SUCCEEDED } from '../../../payments';
import type { RefundSucceededPayload } from '../../../payments';
import { CreditNoteIssuer } from '../../application/credit-note-issuer.service';
import { InvoiceIssuer } from '../../application/invoice-issuer.service';

/**
 * Facturación reacciona a Pedidos:
 *  - OrderPaid → factura del pedido (secuencial, clave de acceso, documento y líneas en la
 *    transacción del relay). En contra entrega, Pedidos emite OrderPaid al entregar (cuando el
 *    motorizado cobra), así que no hace falta escuchar OrderDelivered: se facturaría dos veces.
 *  - RefundSucceeded de una devolución → nota de crédito (04) vinculada a la factura del pedido.
 *    Si la factura todavía no existe, el handler falla y el relay reintenta el evento.
 * Son idempotentes: una segunda entrega del evento devuelve el comprobante existente.
 */
@Injectable()
export class BillingConsumer implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly issuer: InvoiceIssuer,
    private readonly creditNotes: CreditNoteIssuer,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<OrderPaidPayload>(ORDER_PAID, 'billing', async (e) => {
      await this.issuer.issueForOrder(e.tenantId, e.payload.orderId);
    });
    this.bus.subscribe<RefundSucceededPayload>(REFUND_SUCCEEDED, 'billing', async (e) => {
      if (e.payload.returnId) await this.creditNotes.issueForReturn(e.tenantId, e.payload.returnId);
    });
  }
}
