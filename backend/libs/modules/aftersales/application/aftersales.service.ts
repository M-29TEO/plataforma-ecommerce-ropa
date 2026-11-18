import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConflictError, Database, NotFoundError, sniffFileType, toCents, ValidationError } from '../../../shared-kernel';
import { CatalogApi } from '../../catalog';
import { AllocationShortageError, InsufficientStockError, InventoryApi } from '../../inventory';
import { LogisticsApi, ShipmentSummary } from '../../logistics';
import {
  InvalidReturnError,
  ItemInspection,
  OrderNotFoundError,
  OrdersApi,
  ReturnDetail,
  ReturnFilter,
  ReturnProps,
  ReturnReasonCode,
  ReturnType,
} from '../../orders';
import { PaymentsApi, RefundView } from '../../payments';
import { PromotionsApi } from '../../promotions';
import { ReturnPhotoStorage, StoreCreditMailer } from './ports';

export interface PhotoFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export interface RequestReturnCommand {
  tenantId: string;
  userId: string;
  orderId: string;
  type: ReturnType;
  resolution?: 'refund_original' | 'store_credit';
  reason?: string | null;
  customerNotes?: string | null;
  items: { orderItemId: string; quantity: number; reasonCode: ReturnReasonCode; exchangeVariantId?: string | null; photos?: string[] }[];
}

export interface StaffActor {
  tenantId: string;
  userId: string;
}

/** Devolución con lo que otros módulos saben de ella (retiro, reembolso, nota de crédito). */
export interface ReturnOverview extends ReturnDetail {
  pickupShipment: ShipmentSummary | null;
  exchangeShipment: ShipmentSummary | null;
  refund: RefundView | null;
}

export interface InspectionResult {
  return: ReturnOverview;
  /** Cambio sin stock de la talla nueva: queda inspeccionado hasta reintentar el envío. */
  exchangePending: boolean;
}

/**
 * Orquestador de devoluciones y cambios (posventa). Como Checkout, no tiene schema propio: cada
 * paso compone, en UNA transacción (ambiental, ver Database), los casos de uso de Pedidos,
 * Logística, Inventario, Pagos y Promociones por sus fachadas públicas. Así el retiro nace con la
 * aprobación, el stock vuelve con la inspección y el reembolso no queda a medias. Lo asíncrono
 * (nota de crédito, estado del pago del pedido) sigue por eventos del outbox.
 */
@Injectable()
export class AftersalesService {
  private readonly logger = new Logger(AftersalesService.name);

  constructor(
    private readonly db: Database,
    private readonly orders: OrdersApi,
    private readonly catalog: CatalogApi,
    private readonly inventory: InventoryApi,
    private readonly logistics: LogisticsApi,
    private readonly payments: PaymentsApi,
    private readonly promotions: PromotionsApi,
    private readonly photos: ReturnPhotoStorage,
    private readonly mailer: StoreCreditMailer,
  ) {}

  // ------------------------------------------------------------------ cliente

  /** Sube una foto (jpg, png o webp, hasta 5 MB) y devuelve la clave para la solicitud. */
  async uploadPhoto(tenantId: string, userId: string, file: PhotoFile | undefined): Promise<{ key: string; contentType: string }> {
    if (!file || file.size === 0) throw new ValidationError('PHOTO_REQUIRED', 'Adjunta la foto (campo "photo")');
    const ext = PHOTO_TYPES[file.mimetype];
    if (!ext) throw new ValidationError('PHOTO_TYPE', 'La foto debe ser JPG, PNG o WEBP', { mimetype: file.mimetype });
    if (file.size > PHOTO_MAX_BYTES) throw new ValidationError('PHOTO_TOO_LARGE', 'La foto supera 5 MB');
    if (sniffFileType(file.buffer) !== file.mimetype) throw new ValidationError('PHOTO_TYPE', 'El archivo no es una imagen válida');
    const key = `${photoPrefix(tenantId, userId)}${randomUUID()}.${ext}`;
    await this.photos.put(key, file.buffer, file.mimetype);
    return { key, contentType: file.mimetype };
  }

  /**
   * Solicitud del cliente. Valida aquí lo que depende de otros módulos: que las fotos sean suyas y
   * que en un cambio la variante nueva sea otra talla del MISMO producto, vendible y con stock.
   * Cantidades, plazo y motivos los valida el agregado Devolución (Pedidos).
   */
  async requestReturn(cmd: RequestReturnCommand): Promise<ReturnDetail> {
    const order = await this.orders.getOrder(cmd.tenantId, cmd.orderId);
    // Un pedido de otro cliente se reporta como inexistente.
    if (order.userId !== cmd.userId) throw new OrderNotFoundError(cmd.orderId);
    for (const i of cmd.items) {
      if ((i.photos ?? []).some((p) => !isOwnPhotoKey(p, cmd.tenantId, cmd.userId))) {
        throw new InvalidReturnError('INVALID_PHOTO', 'Las fotos deben subirse antes con POST /me/returns/photos', { orderItemId: i.orderItemId });
      }
    }
    await this.assertExchangeVariants(cmd, order.items);
    return this.orders.requestReturn(
      {
        tenantId: cmd.tenantId,
        orderId: cmd.orderId,
        type: cmd.type,
        resolution: cmd.resolution,
        reason: cmd.reason,
        customerNotes: cmd.customerNotes,
        items: cmd.items,
      },
      { type: 'customer', id: cmd.userId },
      cmd.userId,
    );
  }

  getForCustomer(tenantId: string, userId: string, returnId: string): Promise<ReturnDetail> {
    return this.orders.getReturn(tenantId, returnId, userId);
  }

  listForCustomer(tenantId: string, userId: string, filter: Omit<ReturnFilter, 'userId'>): Promise<ReturnProps[]> {
    return this.orders.listReturns(tenantId, { ...filter, userId });
  }

  // ------------------------------------------------------------------ backoffice

  /**
   * Soporte registra la devolución en nombre del cliente: el camino de los pedidos de invitado
   * (sin cuenta no hay /me/...) o de quien llama o escribe por WhatsApp. Mismas reglas del agregado
   * (plazo, cantidades, motivos) y del cambio de talla; sin fotos, porque son del cliente.
   */
  async registerReturn(actor: StaffActor, cmd: Omit<RequestReturnCommand, 'tenantId' | 'userId'>): Promise<ReturnDetail> {
    const order = await this.orders.getOrder(actor.tenantId, cmd.orderId);
    if (cmd.items.some((i) => (i.photos ?? []).length > 0)) {
      throw new InvalidReturnError('INVALID_PHOTO', 'Las fotos las sube el cliente desde su cuenta; soporte registra la devolución sin fotos');
    }
    await this.assertExchangeVariants({ ...cmd, tenantId: actor.tenantId }, order.items);
    return this.orders.requestReturn(
      {
        tenantId: actor.tenantId,
        orderId: cmd.orderId,
        type: cmd.type,
        resolution: cmd.resolution,
        reason: cmd.reason,
        customerNotes: cmd.customerNotes,
        items: cmd.items,
      },
      { type: 'staff', id: actor.userId },
    );
  }

  /** En un cambio, la variante nueva es otra talla del MISMO producto, vendible y con stock. */
  private async assertExchangeVariants(
    cmd: Pick<RequestReturnCommand, 'tenantId' | 'type' | 'items'>,
    orderItems: { id: string; productId: string }[],
  ): Promise<void> {
    if (cmd.type === 'exchange') {
      const byItem = new Map(orderItems.map((i) => [i.id, i]));
      const ids = cmd.items.map((i) => i.exchangeVariantId).filter((v): v is string => !!v);
      const variants = await this.catalog.getSellableVariants(cmd.tenantId, ids);
      for (const i of cmd.items) {
        const line = byItem.get(i.orderItemId);
        const v = i.exchangeVariantId ? variants.get(i.exchangeVariantId) : undefined;
        if (line && i.exchangeVariantId && (!v || !v.purchasable || v.productId !== line.productId)) {
          throw new InvalidReturnError('EXCHANGE_VARIANT_INVALID', 'El cambio es por otra talla del mismo producto, disponible para la venta', {
            orderItemId: i.orderItemId,
            exchangeVariantId: i.exchangeVariantId,
          });
        }
      }
      await this.assertExchangeStock(cmd.tenantId, cmd.items.map((i) => ({ variantId: i.exchangeVariantId ?? '', quantity: i.quantity })));
    }
  }

  /** Aprobación + retiro vía Logística (shipment 'return') en la misma transacción. */
  async approve(actor: StaffActor, returnId: string): Promise<ReturnOverview> {
    await this.db.withTransaction(async () => {
      const current = await this.orders.getReturn(actor.tenantId, returnId);
      if (current.type === 'exchange' && current.status === 'requested') {
        await this.assertExchangeStock(actor.tenantId, current.lines.map((l) => ({ variantId: l.exchangeVariantId ?? '', quantity: l.quantity })));
      }
      const ret = await this.orders.approveReturn(actor.tenantId, returnId, actor.userId);
      await this.logistics.scheduleReturnPickup({
        tenantId: actor.tenantId,
        orderId: ret.orderId,
        returnId: ret.id,
        rmaNumber: ret.rmaNumber,
        fulfillmentType: ret.order.fulfillmentType,
        address: ret.order.shippingAddress,
        location: ret.order.shippingLocation,
        city: ret.order.shippingCity,
        warehouseId: ret.order.sourceWarehouseId ?? ret.lines.find((l) => l.warehouseId)?.warehouseId ?? null,
        weightG: await this.weight(actor.tenantId, ret.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }))),
        items: ret.lines.map((l) => ({ orderItemId: l.orderItemId, quantity: l.quantity })),
      });
      await this.orders.markReturnPickupScheduled(actor.tenantId, returnId);
    });
    return this.overview(actor.tenantId, returnId);
  }

  async reject(actor: StaffActor, returnId: string, reason: string): Promise<ReturnOverview> {
    await this.orders.rejectReturn(actor.tenantId, returnId, actor.userId, reason);
    return this.overview(actor.tenantId, returnId);
  }

  /** Bodega recibió el paquete: la devolución y el envío de retiro cambian juntos. */
  async receive(actor: StaffActor, returnId: string, warehouseId: string | null): Promise<ReturnOverview> {
    await this.db.withTransaction(async () => {
      await this.orders.receiveReturn(actor.tenantId, returnId, actor.userId);
      await this.logistics.markReturnReceived(actor.tenantId, returnId, warehouseId);
    });
    return this.overview(actor.tenantId, returnId);
  }

  /**
   * Inspección en bodega, en una transacción: la devolución queda inspeccionada (y el pedido
   * parcial o totalmente devuelto), lo que está en buen estado vuelve al stock de la bodega que lo
   * recibió y se solicita el reembolso (devolución) o se despacha la talla nueva (cambio). Si no
   * hay stock de la talla nueva, el cambio queda inspeccionado para reintentar el envío.
   */
  async inspect(actor: StaffActor, returnId: string, inspections: ItemInspection[]): Promise<InspectionResult> {
    const exchangePending = await this.db.withTransaction(async () => {
      const ret = await this.orders.inspectReturn(actor.tenantId, returnId, { type: 'staff', id: actor.userId }, inspections);
      const warehouseId = await this.receivingWarehouse(actor.tenantId, ret);
      const restock = ret.lines.filter((l) => l.restock).map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
      if (restock.length) {
        await this.inventory.restockReturn({
          tenantId: actor.tenantId,
          returnId: ret.id,
          warehouseId,
          userId: actor.userId,
          reason: `Devolución ${ret.rmaNumber}`,
          lines: restock,
        });
      }
      if (ret.type === 'return' && ret.refundAmount && toCents(ret.refundAmount) > 0) {
        await this.payments.requestRefund({
          tenantId: actor.tenantId,
          orderId: ret.orderId,
          returnId: ret.id,
          amount: ret.refundAmount,
          resolution: ret.resolution === 'store_credit' ? 'store_credit' : 'refund_original',
          reason: `Devolución ${ret.rmaNumber}`,
          requestedBy: actor.userId,
        });
      }
      if (ret.type !== 'exchange') return false;
      try {
        // Savepoint: sin stock se revierte solo el intento de despacho, no la inspección.
        await this.db.withTransaction(() => this.dispatchExchange(actor, ret, warehouseId));
        return false;
      } catch (error) {
        if (!(error instanceof AllocationShortageError || error instanceof InsufficientStockError)) throw error;
        this.logger.warn(`Cambio ${ret.rmaNumber} sin stock de la talla nueva: queda pendiente de envío`);
        return true;
      }
    });
    return { return: await this.overview(actor.tenantId, returnId), exchangePending };
  }

  /** Reintento manual del envío de un cambio que quedó sin stock en la inspección. */
  async retryExchangeShipment(actor: StaffActor, returnId: string): Promise<ReturnOverview> {
    await this.db.withTransaction(async () => {
      const ret = await this.orders.getReturn(actor.tenantId, returnId);
      if (ret.type !== 'exchange' || ret.status !== 'inspected') {
        throw new ConflictError('EXCHANGE_NOT_PENDING', 'Solo un cambio inspeccionado y sin enviar admite el reintento', {
          returnId,
          type: ret.type,
          status: ret.status,
        });
      }
      await this.dispatchExchange(actor, ret, await this.receivingWarehouse(actor.tenantId, ret));
    });
    return this.overview(actor.tenantId, returnId);
  }

  /**
   * Aprobación de un reembolso (doble por encima del umbral). Con la aprobación completa, en la
   * misma transacción, ejecuta las partes internas del plan: gift card nueva de saldo a favor (con
   * el email del código: si el SMTP falla, todo se revierte y el código no se pierde) o saldo de
   * vuelta a las gift cards del pedido. Después, fuera de la transacción, el reverso en la pasarela.
   */
  async approveRefund(actor: StaffActor, refundId: string): Promise<RefundView> {
    const result = await this.db.withTransaction(async () => {
      const approval = await this.payments.approveRefund(actor.tenantId, refundId, actor.userId);
      const plan = approval.plan;
      if (!plan) return approval;
      const refund = approval.refund;
      if (toCents(plan.storeCredit) > 0) {
        const ret = refund.returnId ? await this.orders.getReturn(actor.tenantId, refund.returnId) : null;
        const email = ret?.order.customer.email ?? null;
        if (!email) throw new ConflictError('CUSTOMER_EMAIL_REQUIRED', 'No hay email para entregar el código de la gift card', { refundId });
        const card = await this.promotions.issueGiftCard({
          tenantId: actor.tenantId,
          amount: plan.storeCredit,
          recipientEmail: email,
          purchaserId: ret?.order.userId ?? null,
        });
        await this.mailer.send({
          to: email,
          customerName: ret?.order.customer.name ?? 'cliente',
          rmaNumber: ret?.rmaNumber ?? '',
          amount: plan.storeCredit,
          code: card.code,
          last4: card.last4,
        });
        await this.payments.completeRefundPart(actor.tenantId, refundId, 'store_credit', `gift_card:${card.giftCardId}`);
      }
      if (toCents(plan.giftCards) > 0) {
        const { refunded } = await this.promotions.refundGiftCards(actor.tenantId, refund.orderId, plan.giftCards);
        await this.payments.completeRefundPart(actor.tenantId, refundId, 'gift_cards', `gift_cards:${refunded}`);
      }
      return approval;
    });
    if (result.plan?.external?.kind === 'gateway') return this.payments.executeGatewayRefund(actor.tenantId, refundId);
    return this.payments.getRefund(actor.tenantId, refundId);
  }

  list(tenantId: string, filter: ReturnFilter): Promise<ReturnProps[]> {
    return this.orders.listReturns(tenantId, filter);
  }

  async overview(tenantId: string, returnId: string): Promise<ReturnOverview> {
    const ret = await this.orders.getReturn(tenantId, returnId);
    const [pickupShipment, exchangeShipment, refund] = await Promise.all([
      this.logistics.getReturnShipment(tenantId, returnId, 'return'),
      this.logistics.getReturnShipment(tenantId, returnId, 'exchange'),
      this.payments.findRefundByReturn(tenantId, returnId),
    ]);
    return { ...ret, pickupShipment, exchangeShipment, refund };
  }

  /** Foto de una línea (backoffice). index: posición en la lista de fotos de la línea. */
  async photo(tenantId: string, returnId: string, returnItemId: string, index: number): Promise<{ content: Buffer; contentType: string }> {
    const ret = await this.orders.getReturn(tenantId, returnId);
    const key = ret.lines.find((l) => l.returnItemId === returnItemId)?.photos[index];
    const file = key ? await this.photos.get(key) : null;
    if (!file) throw new NotFoundError('PHOTO_NOT_FOUND', 'Foto no encontrada', { returnId, returnItemId, index });
    return file;
  }

  // ------------------------------------------------------------------ internos

  /** Salida de la talla nueva (Inventario) + envío 'exchange' (Logística) + devolución exchanged. */
  private async dispatchExchange(actor: StaffActor, ret: ReturnDetail, receivingWarehouseId: string): Promise<void> {
    const lines = ret.lines.map((l) => ({ variantId: l.exchangeVariantId!, quantity: l.quantity }));
    const issued = await this.inventory.issueForExchange({
      tenantId: actor.tenantId,
      returnId: ret.id,
      userId: actor.userId,
      reason: `Cambio ${ret.rmaNumber}`,
      lines,
      preferredWarehouseId: receivingWarehouseId,
    });
    // Un envío por cambio: sale de la bodega con más unidades (si Inventario repartió, bodega consolida).
    const byWarehouse = new Map<string, number>();
    for (const l of issued) byWarehouse.set(l.warehouseId, (byWarehouse.get(l.warehouseId) ?? 0) + l.quantity);
    const origin = [...byWarehouse].sort((a, b) => b[1] - a[1])[0][0];
    await this.logistics.createExchangeShipment({
      tenantId: actor.tenantId,
      orderId: ret.orderId,
      returnId: ret.id,
      rmaNumber: ret.rmaNumber,
      fulfillmentType: ret.order.fulfillmentType,
      address: ret.order.shippingAddress,
      location: ret.order.shippingLocation,
      city: ret.order.shippingCity,
      warehouseId: origin,
      weightG: await this.weight(actor.tenantId, lines),
      items: ret.lines.map((l) => ({ orderItemId: l.orderItemId, quantity: l.quantity })),
    });
    await this.orders.markReturnExchanged(actor.tenantId, ret.id);
  }

  /** Bodega que recibió la devolución (el envío de retiro la registra al recibirla). */
  private async receivingWarehouse(tenantId: string, ret: ReturnDetail): Promise<string> {
    const shipment = await this.logistics.getReturnShipment(tenantId, ret.id, 'return');
    const warehouseId = shipment?.originWarehouseId ?? ret.order.sourceWarehouseId ?? ret.lines.find((l) => l.warehouseId)?.warehouseId;
    if (!warehouseId) throw new ConflictError('RECEIVING_WAREHOUSE_UNKNOWN', 'No se sabe qué bodega recibió la devolución', { returnId: ret.id });
    return warehouseId;
  }

  /** Chequeo previo (sin reservar): la salida real, atómica, ocurre al despachar el cambio. */
  private async assertExchangeStock(tenantId: string, lines: { variantId: string; quantity: number }[]): Promise<void> {
    const wanted = new Map<string, number>();
    for (const l of lines) if (l.variantId) wanted.set(l.variantId, (wanted.get(l.variantId) ?? 0) + l.quantity);
    const available = await this.inventory.getAvailability(tenantId, [...wanted.keys()]);
    const short = [...wanted].filter(([id, qty]) => (available.get(id) ?? 0) < qty);
    if (short.length) {
      throw new ConflictError('EXCHANGE_OUT_OF_STOCK', 'No hay stock de la talla pedida para el cambio', {
        shortages: short.map(([variantId, requested]) => ({ variantId, requested, available: available.get(variantId) ?? 0 })),
      });
    }
  }

  private async weight(tenantId: string, lines: { variantId: string; quantity: number }[]): Promise<number> {
    const variants = await this.catalog.getSellableVariants(tenantId, lines.map((l) => l.variantId));
    return lines.reduce((s, l) => s + (variants.get(l.variantId)?.weightG ?? 0) * l.quantity, 0);
  }
}

function photoPrefix(tenantId: string, userId: string): string {
  return `returns/photos/${tenantId}/${userId}/`;
}

const PHOTO_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.(jpg|png|webp)$/;

/**
 * Exactamente una clave emitida por uploadPhoto para ESE cliente: el prefijo solo no basta
 * ("returns/photos/<t>/<u>/../../../payments/..." empieza igual y apunta a otro objeto).
 */
function isOwnPhotoKey(key: string, tenantId: string, userId: string): boolean {
  const prefix = photoPrefix(tenantId, userId);
  return key.startsWith(prefix) && PHOTO_FILE.test(key.slice(prefix.length));
}
