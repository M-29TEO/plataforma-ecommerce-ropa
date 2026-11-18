import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventBus, PublishedEvent } from '../../../../shared-kernel';
import { INVOICE_REJECTED } from '../../../billing';
import type { InvoiceRejectedPayload } from '../../../billing';
import { OrdersApi } from '../../../orders';
import { TicketService } from '../../application/ticket.service';

const CONSUMER = 'support';

/**
 * Soporte reacciona a Facturación: un comprobante DEVUELTO o NO AUTORIZADO por el SRI abre un
 * ticket interno (categoría invoice, prioridad alta) para que alguien lo corrija y lo reenvíe.
 * Idempotente por source_ref: un evento repetido no abre otro ticket.
 */
@Injectable()
export class SupportConsumer implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly tickets: TicketService,
    private readonly orders: OrdersApi,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<InvoiceRejectedPayload>(INVOICE_REJECTED, CONSUMER, (e) => this.invoiceRejected(e));
  }

  private async invoiceRejected(e: PublishedEvent<InvoiceRejectedPayload>): Promise<void> {
    const p = e.payload;
    const order = p.orderId ? await this.orders.getOrder(e.tenantId, p.orderId).catch(() => null) : null;
    const doc = p.docType === '04' ? 'Nota de crédito' : 'Factura';
    const status = p.status === 'returned' ? 'DEVUELTA' : 'NO AUTORIZADA';
    const messages = p.messages.map((m) => `- [${m.identificador}] ${m.mensaje}${m.informacionAdicional ? ` (${m.informacionAdicional})` : ''}`);
    await this.tickets.createFromEvent({
      tenantId: e.tenantId,
      // Un ticket por comprobante y resultado: si se corrige y el SRI lo rechaza de nuevo por otra
      // razón (DEVUELTA → NO AUTORIZADA), es otro problema.
      sourceRef: `invoice:${p.documentId}:${p.status}`,
      orderId: order?.id ?? null,
      category: 'invoice',
      priority: 'high',
      subject: `${doc} ${status} por el SRI${order?.orderNumber ? ` · pedido #${order.orderNumber}` : ''}`,
      body: [`Clave de acceso: ${p.accessKey}`, `Estado: ${status}`, ...(messages.length ? ['Mensajes del SRI:', ...messages] : [])].join('\n'),
    });
  }
}
