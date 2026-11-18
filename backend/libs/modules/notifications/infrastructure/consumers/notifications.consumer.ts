import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, AppConfig, EventBus, fromCents, PublishedEvent, toCents } from '../../../../shared-kernel';
import { INVOICE_AUTHORIZED, INVOICE_REJECTED } from '../../../billing';
import type { InvoiceAuthorizedPayload, InvoiceRejectedPayload } from '../../../billing';
import { CART_ABANDONED } from '../../../cart';
import type { CartAbandonedPayload } from '../../../cart';
import { SHIPMENT_STATUS_CHANGED } from '../../../logistics';
import type { ShipmentStatusChangedPayload } from '../../../logistics';
import { ORDER_CANCELLED, ORDER_DELIVERED, ORDER_PAID, ORDER_PLACED, OrdersApi } from '../../../orders';
import type { OrderCancelledPayload, OrderDeliveredPayload, OrderDetail, OrderPaidPayload, OrderPlacedPayload } from '../../../orders';
import { TICKET_CLOSED, TICKET_CREATED, TICKET_REPLIED, TICKET_SLA_BREACHED } from '../../../support';
import type { TicketClosedPayload, TicketCreatedPayload, TicketRepliedPayload, TicketRequester, TicketSlaBreachedPayload } from '../../../support';
import { Audience, NotificationService } from '../../application/notification.service';
import { cartReminderTemplate, shipmentTemplate, TemplateCode } from '../../domain/catalog';

const CONSUMER = 'notifications';

function firstName(fullName: string | null | undefined): string | null {
  return fullName?.trim().split(/\s+/)[0] || null;
}

function variantLabel(color: string | null, size: string | null): string | null {
  return [color, size].filter(Boolean).join(' / ') || null;
}

/**
 * Notificaciones reacciona a Pedidos, Logística, Facturación, Carrito y Soporte. Cada handler arma los datos
 * de la plantilla y encola con NotificationService dentro de la transacción del relay: es
 * idempotente por dedupe_key (un evento repetido no duplica mensajes).
 *
 *  - OrderPlaced / OrderPaid / OrderCancelled / OrderDelivered → cliente del pedido. OrderPaid no
 *    se avisa en contra entrega: ahí se emite al entregar y ya llega OrderDelivered.
 *  - ShipmentStatusChanged → cliente, solo los estados de catalog.shipmentTemplate.
 *  - InvoiceAuthorized → push al cliente (el email con RIDE y XML lo manda Facturación).
 *  - InvoiceRejected → alerta ntfy al backoffice.
 *  - CartAbandoned → recordatorio de MARKETING (exige consentimiento por canal).
 *  - TicketCreated / TicketReplied / TicketClosed → email al cliente del ticket (acuse, respuesta
 *    del agente, encuesta CSAT) con el enlace firmado. TicketSlaBreached → alerta ntfy al backoffice.
 */
@Injectable()
export class NotificationsConsumer implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly notifications: NotificationService,
    private readonly orders: OrdersApi,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<OrderPlacedPayload>(ORDER_PLACED, CONSUMER, (e) => this.order(e, 'order.placed'));
    this.bus.subscribe<OrderPaidPayload>(ORDER_PAID, CONSUMER, async (e) => {
      if (e.payload.paymentMethod !== 'cod') await this.order(e, 'order.paid');
    });
    this.bus.subscribe<OrderCancelledPayload>(ORDER_CANCELLED, CONSUMER, (e) =>
      this.order(e, 'order.cancelled', { reason: e.payload.reason, paymentStatus: e.payload.paymentStatus }),
    );
    this.bus.subscribe<OrderDeliveredPayload>(ORDER_DELIVERED, CONSUMER, (e) => this.order(e, 'order.delivered', { deliveredAt: e.payload.deliveredAt }));
    this.bus.subscribe<ShipmentStatusChangedPayload>(SHIPMENT_STATUS_CHANGED, CONSUMER, (e) => this.shipment(e));
    this.bus.subscribe<InvoiceAuthorizedPayload>(INVOICE_AUTHORIZED, CONSUMER, (e) => this.invoiceAuthorized(e));
    this.bus.subscribe<InvoiceRejectedPayload>(INVOICE_REJECTED, CONSUMER, (e) => this.invoiceRejected(e));
    this.bus.subscribe<CartAbandonedPayload>(CART_ABANDONED, CONSUMER, (e) => this.cartAbandoned(e));
    this.bus.subscribe<TicketCreatedPayload>(TICKET_CREATED, CONSUMER, (e) => this.ticketCreated(e));
    this.bus.subscribe<TicketRepliedPayload>(TICKET_REPLIED, CONSUMER, (e) => this.ticketReplied(e));
    this.bus.subscribe<TicketClosedPayload>(TICKET_CLOSED, CONSUMER, (e) => this.ticketClosed(e));
    this.bus.subscribe<TicketSlaBreachedPayload>(TICKET_SLA_BREACHED, CONSUMER, (e) => this.ticketSlaBreached(e));
  }

  private get base(): string {
    return this.config.notifications.storefrontUrl;
  }

  private customer(o: OrderDetail): Audience {
    return { kind: 'customer', userId: o.userId, email: o.customer.email, phone: o.customer.phone ?? null, name: firstName(o.customer.name) };
  }

  private orderData(o: OrderDetail): Record<string, unknown> {
    const orderUrl = `${this.base}/pedidos/${o.id}`;
    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      total: o.total,
      currency: o.currency,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      fulfillmentType: o.fulfillmentType,
      placedAt: o.placedAt.toISOString(),
      deliveredAt: o.deliveredAt?.toISOString() ?? null,
      reason: o.cancelReason,
      returnWindowDays: this.config.aftersales.returnWindowDays,
      items: o.items.map((i) => ({ name: i.productName, variant: variantLabel(i.colorName, i.sizeCode), quantity: i.quantity, amount: i.lineTotal })),
      orderUrl,
      url: orderUrl,
    };
  }

  private async order(e: PublishedEvent<{ orderId: string }>, code: TemplateCode, extra: Record<string, unknown> = {}): Promise<void> {
    const o = await this.orders.getOrder(e.tenantId, e.payload.orderId);
    await this.notifications.notify({ tenantId: e.tenantId, templateCode: code, sourceId: o.id, to: this.customer(o), data: { ...this.orderData(o), ...extra } });
  }

  private async shipment(e: PublishedEvent<ShipmentStatusChangedPayload>): Promise<void> {
    const p = e.payload;
    const code = shipmentTemplate(p.direction, p.status);
    if (!code) return;
    const o = await this.orders.getOrder(e.tenantId, p.orderId);
    const trackingUrl = `${this.base}/seguimiento/${p.trackingToken}`;
    await this.notifications.notify({
      tenantId: e.tenantId,
      templateCode: code,
      // El mismo estado puede repetirse (dos intentos fallidos): la fuente incluye cuándo ocurrió.
      sourceId: `${p.shipmentId}:${p.occurredAt}`,
      to: this.customer(o),
      data: { ...this.orderData(o), carrierType: p.carrierType, description: p.description, trackingUrl, url: trackingUrl },
    });
  }

  private async invoiceAuthorized(e: PublishedEvent<InvoiceAuthorizedPayload>): Promise<void> {
    const p = e.payload;
    if (!p.orderId) return;
    const o = await this.orders.getOrder(e.tenantId, p.orderId);
    const invoiceUrl = `${this.base}/pedidos/${o.id}/factura`;
    await this.notifications.notify({
      tenantId: e.tenantId,
      templateCode: 'invoice.authorized',
      sourceId: p.documentId,
      to: this.customer(o),
      data: { orderNumber: o.orderNumber, docType: p.docType, total: p.total, accessKey: p.accessKey, authorizationNumber: p.authorizationNumber, invoiceUrl, url: invoiceUrl },
    });
  }

  private async invoiceRejected(e: PublishedEvent<InvoiceRejectedPayload>): Promise<void> {
    const p = e.payload;
    const orderNumber = p.orderId ? await this.orders.getOrder(e.tenantId, p.orderId).then((o) => o.orderNumber, () => null) : null;
    await this.notifications.notify({
      tenantId: e.tenantId,
      templateCode: 'invoice.rejected',
      sourceId: `${p.documentId}:${p.status}`,
      to: { kind: 'staff' },
      data: {
        docLabel: p.docType === '04' ? 'nota de crédito' : 'factura',
        statusLabel: p.status === 'returned' ? 'DEVUELTA' : 'NO AUTORIZADA',
        accessKey: p.accessKey,
        orderNumber,
        messages: p.messages.map((m) => ({ identifier: m.identificador, message: m.mensaje, additionalInfo: m.informacionAdicional })),
      },
    });
  }

  private async cartAbandoned(e: PublishedEvent<CartAbandonedPayload>): Promise<void> {
    const p = e.payload;
    const code = cartReminderTemplate(p.stageLabel);
    if (!code) return;
    const cartUrl = `${this.base}/carrito`;
    await this.notifications.notify({
      tenantId: e.tenantId,
      templateCode: code,
      // La cuenta de recordatorios se reinicia con cada actividad: la fuente es el carrito en esa actividad.
      sourceId: `${p.cartId}:${p.lastActivityAt}`,
      to: { kind: 'customer', userId: p.userId, email: p.contactEmail, phone: p.contactPhone },
      data: {
        stage: p.stage,
        itemCount: p.itemCount,
        total: p.total,
        currency: p.currency,
        items: p.lines.map((l) => ({
          name: l.productName ?? 'Prenda',
          variant: variantLabel(l.colorName, l.sizeCode),
          quantity: l.quantity,
          amount: fromCents(toCents(l.unitPrice) * l.quantity),
        })),
        cartUrl,
        url: cartUrl,
      },
    });
  }
  // ------------------------------------------------------------------ soporte

  private requester(r: TicketRequester): Audience {
    return { kind: 'customer', userId: r.userId, email: r.email, phone: r.phone, name: firstName(r.name) };
  }

  private ticketUrl(accessToken: string): string {
    return `${this.base}/soporte/t/${accessToken}`;
  }

  private async orderNumber(tenantId: string, orderId: string | null): Promise<string | null> {
    return orderId ? this.orders.getOrder(tenantId, orderId).then((o) => o.orderNumber, () => null) : null;
  }

  /** Acuse de recibo con el enlace (para el invitado, la única forma de volver al ticket). */
  private async ticketCreated(e: PublishedEvent<TicketCreatedPayload>): Promise<void> {
    const p = e.payload;
    if (!p.requester || !p.accessToken || p.createdBy === 'system') return;
    const ticketUrl = this.ticketUrl(p.accessToken);
    await this.notifications.notify({
      tenantId: e.tenantId,
      templateCode: 'ticket.created',
      sourceId: p.ticketId,
      to: this.requester(p.requester),
      data: { number: p.number, subject: p.subject, category: p.category, orderNumber: await this.orderNumber(e.tenantId, p.orderId), ticketUrl, url: ticketUrl },
    });
  }

  private async ticketReplied(e: PublishedEvent<TicketRepliedPayload>): Promise<void> {
    const p = e.payload;
    const ticketUrl = this.ticketUrl(p.accessToken);
    await this.notifications.notify({
      tenantId: e.tenantId,
      templateCode: 'ticket.reply',
      // Una respuesta = un email: la fuente es el mensaje.
      sourceId: `${p.ticketId}:${p.messageId}`,
      to: this.requester(p.requester),
      data: { number: p.number, subject: p.subject, body: p.body, status: p.status, ticketUrl, url: ticketUrl },
    });
  }

  /** Encuesta CSAT: un enlace por puntaje (la página del storefront confirma y envía la respuesta). */
  private async ticketClosed(e: PublishedEvent<TicketClosedPayload>): Promise<void> {
    const p = e.payload;
    if (!p.requester || !p.accessToken) return;
    const ticketUrl = this.ticketUrl(p.accessToken);
    const csatUrl = `${ticketUrl}/encuesta`;
    await this.notifications.notify({
      tenantId: e.tenantId,
      templateCode: 'ticket.csat',
      sourceId: p.ticketId,
      to: this.requester(p.requester),
      data: {
        number: p.number,
        subject: p.subject,
        closedBy: p.closedBy,
        scores: [1, 2, 3, 4, 5].map((score) => ({ score, url: `${csatUrl}?score=${score}` })),
        csatUrl,
        ticketUrl,
        url: csatUrl,
      },
    });
  }

  private async ticketSlaBreached(e: PublishedEvent<TicketSlaBreachedPayload>): Promise<void> {
    const p = e.payload;
    await this.notifications.notify({
      tenantId: e.tenantId,
      templateCode: 'ticket.sla_breached',
      // Puede volver a vencer si se sube la prioridad y se recalcula el SLA: la fuente incluye cuándo.
      sourceId: `${p.ticketId}:${p.breachedAt}`,
      to: { kind: 'staff' },
      data: {
        number: p.number,
        subject: p.subject,
        priority: p.priority,
        category: p.category,
        status: p.status,
        assignedTo: p.assignedTo,
        slaDueAt: p.slaDueAt,
        orderNumber: await this.orderNumber(e.tenantId, p.orderId),
      },
    });
  }
}
