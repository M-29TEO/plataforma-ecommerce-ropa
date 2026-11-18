import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { fromCents, IdempotencyStore, IdempotentResponse, toCents } from '../../../shared-kernel';
import { BillingApi } from '../../billing';
import { CartApi, CartNotFoundError, CartView } from '../../cart';
import { CatalogApi, SellableVariant } from '../../catalog';
import { InventoryApi } from '../../inventory';
import { DeliveryQuote, LogisticsApi, ResolvedDelivery } from '../../logistics';
import { Actor, CustomerSnapshot, FulfillmentType, OrderChannel, OrdersApi } from '../../orders';
import { PaymentCreated, PaymentMethod, PaymentsApi } from '../../payments';
import { PromotionsApi } from '../../promotions';
import {
  blockingIssues,
  CartNotReadyError,
  CheckoutPaymentMethod,
  CheckoutTotalChangedError,
  giftCardAmount,
  InvalidCheckoutError,
  Parcel,
  parcelOf,
  reservationTtlSeconds,
  sourceWarehouse,
  toOrderItems,
} from '../domain/checkout';

export interface CheckoutCommand {
  tenantId: string;
  userId: string | null;
  /** Cookie del carrito de invitado (en claro). */
  guestToken: string | null;
  idempotencyKey: string;
  customer: CustomerSnapshot;
  billing?: Record<string, unknown> | null;
  fulfillmentType: FulfillmentType;
  shippingAddress?: Record<string, unknown> | null;
  shippingLocation?: { lat: number; lng: number } | null;
  shippingCity?: string | null;
  shippingProvince?: string | null;
  /** Opción elegida en POST /checkout/delivery-options (obligatoria salvo retiro en tienda). */
  deliveryQuoteId?: string | null;
  /** Franja elegida (obligatoria con motorizado). */
  deliverySlotId?: string | null;
  /** Retiro en tienda: bodega/tienda donde se retira. */
  pickupWarehouseId?: string | null;
  paymentMethod: CheckoutPaymentMethod;
  giftCardCode?: string | null;
  /** Total que vio el cliente (lo que pagará). Si no coincide con el recalculado: 409. */
  expectedTotal?: string | null;
  notes?: string | null;
  channel?: 'web' | 'app';
}

/**
 * De dónde salen los precios de lo que se compra: el carrito persistido del cliente (checkout web)
 * o un borrador en memoria (pedido asistido). `price(envío)` recalcula con el envío cotizado.
 */
export interface PricingSource {
  /** sales.orders.cart_id (null en pedidos asistidos: no hay carrito). */
  cartId: string | null;
  price(shippingTotal?: string): Promise<CartView>;
}

/** Datos para crear pedido y pago (pasos 2-7), comunes al checkout web y a los pedidos asistidos. */
export type PlacementCommand = Omit<CheckoutCommand, 'guestToken' | 'idempotencyKey' | 'channel' | 'paymentMethod'> & {
  paymentMethod: CheckoutPaymentMethod;
  channel: OrderChannel;
  /** Vendedor del backoffice que tomó el pedido (sales.orders.seller_id). */
  sellerId: string | null;
  /** Quién crea el pedido (historial de estados). */
  actor: Actor;
  /**
   * Plazo propio del pago en segundos (pedidos asistidos); null o ausente = el del método. No se
   * aplica si la gift card cubre todo. La reserva de stock dura este plazo más el margen.
   */
  paymentTtlSeconds?: number | null;
};

export interface DeliveryOptionsCommand {
  tenantId: string;
  userId: string | null;
  guestToken: string | null;
  location: { lat: number; lng: number };
  city: string;
  province?: string | null;
}

export interface CheckoutResult {
  orderId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  totals: {
    subtotal: string;
    discountTotal: string;
    taxTotal: string;
    shippingTotal: string;
    giftCardTotal: string;
    total: string;
  };
  delivery: {
    fulfillmentType: FulfillmentType;
    shipmentId: string | null;
    /** Enlace público de seguimiento (/seguimiento/<token>); null en retiro en tienda. */
    trackingToken: string | null;
    zoneId: string | null;
    deliverySlotId: string | null;
  };
  payment: PaymentCreated;
}

/**
 * Orquestador del checkout. No tiene tablas: compone las fachadas públicas de Carrito, Catálogo,
 * Inventario, Logística, Promociones, Pedidos y Pagos en UNA transacción de PostgreSQL (la
 * transacción ambiental de Database: cada fachada abre su withTransaction, que se une a esta como
 * savepoint). Si cualquier paso falla (stock, cupo de la franja, cupo de cupón, saldo de gift
 * card...), no queda nada: ni reserva, ni cupo, ni canje, ni pedido, ni pago.
 *
 * El envío se cotiza ANTES, en deliveryOptions (fuera de la transacción: OSRM y couriers pueden
 * tardar hasta 3 s). Al pagar solo se valida la opción firmada y se reserva el cupo.
 *
 * Idempotencia (doble clic en "Pagar", reintento de red): header Idempotency-Key en
 * platform.idempotency_keys, dentro de la misma transacción. La segunda petición espera a la
 * primera y recibe exactamente la misma respuesta (mismo pedido, mismo pago).
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly idempotency: IdempotencyStore,
    private readonly carts: CartApi,
    private readonly catalog: CatalogApi,
    private readonly inventory: InventoryApi,
    private readonly logistics: LogisticsApi,
    private readonly promotions: PromotionsApi,
    private readonly orders: OrdersApi,
    private readonly payments: PaymentsApi,
    private readonly billing: BillingApi,
  ) {}

  /**
   * POST /checkout/delivery-options: cómo y a qué precio se entrega el carrito actual en esa
   * dirección (motorizado con franjas o couriers). Sin transacción ni bloqueos.
   */
  async deliveryOptions(cmd: DeliveryOptionsCommand): Promise<DeliveryQuote> {
    if (!this.carts.ownerRef(cmd.userId, cmd.guestToken)) throw new CartNotFoundError();
    const cartId = await this.carts.findActiveCartId(cmd.tenantId, cmd.userId, cmd.guestToken);
    const { cart, parcel } = await this.pricedParcel(cmd.tenantId, this.cartSource(cmd.tenantId, cartId));
    return this.quoteParcel(cmd.tenantId, cart, parcel, { ...cmd.location, city: cmd.city, province: cmd.province ?? null });
  }

  /** Cotiza el envío de mercadería ya valorizada a un destino (checkout web y pedidos asistidos). */
  quoteParcel(
    tenantId: string,
    cart: CartView,
    parcel: Parcel,
    destination: { lat: number; lng: number; city: string; province?: string | null },
  ): Promise<DeliveryQuote> {
    return this.logistics.quoteDelivery({
      tenantId,
      destination: { ...destination, province: destination.province ?? null },
      weightG: parcel.weightG,
      volumeCm3: parcel.volumeCm3,
      merchandiseTotal: cart.totals.total,
    });
  }

  async checkout(cmd: CheckoutCommand): Promise<IdempotentResponse<CheckoutResult>> {
    const userRef = this.carts.ownerRef(cmd.userId, cmd.guestToken);
    if (!userRef) throw new CartNotFoundError();
    const { tenantId: _t, userId: _u, guestToken: _g, idempotencyKey, ...request } = cmd;
    return this.idempotency.execute(
      { scope: 'checkout', userRef, key: idempotencyKey, request },
      async () => ({ status: 201, body: await this.place(cmd, `${userRef}:${idempotencyKey}`) }),
    );
  }

  /** Corre dentro de la transacción que abrió IdempotencyStore. */
  private async place(cmd: CheckoutCommand, paymentKey: string): Promise<CheckoutResult> {
    assertFulfillment(cmd);
    // 1. Carrito bloqueado; los totales se recalculan dentro de placePriced.
    const cartId = await this.carts.lockCartForCheckout(cmd.tenantId, cmd.userId, cmd.guestToken);
    const result = await this.placePriced(
      { ...cmd, channel: cmd.channel ?? 'web', sellerId: null, actor: { type: cmd.userId ? 'customer' : 'system', id: cmd.userId } },
      this.cartSource(cmd.tenantId, cartId),
      paymentKey,
    );
    // 8. El carrito deja de estar activo.
    await this.carts.markConverted(cmd.tenantId, cartId);
    return result;
  }

  /** Carrito persistido como fuente de precios. */
  private cartSource(tenantId: string, cartId: string): PricingSource {
    return { cartId, price: (shippingTotal) => this.carts.getPricedCart(tenantId, cartId, shippingTotal) };
  }

  /**
   * Pasos 2-7 del checkout sobre una fuente de precios (el carrito del cliente o los ítems que
   * arma un vendedor en un pedido asistido). DEBE correr dentro de una transacción (la de
   * IdempotencyStore): todo o nada. No toca el carrito.
   */
  async placePriced(cmd: PlacementCommand, source: PricingSource, paymentKey: string): Promise<CheckoutResult> {
    assertFulfillment(cmd);
    const pickup = cmd.fulfillmentType === 'pickup';
    const cartId = source.cartId;

    // 1. Totales recalculados con precios, stock y promociones vigentes.
    const { cart: merchandise, variants, parcel } = await this.pricedParcel(cmd.tenantId, source);

    // 2. Envío: la opción firmada debe corresponder a esta mercadería y esta dirección.
    const delivery: ResolvedDelivery | null = pickup
      ? null
      : await this.logistics.resolveDelivery({
          tenantId: cmd.tenantId,
          quoteId: cmd.deliveryQuoteId!,
          slotId: cmd.deliverySlotId ?? null,
          destination: cmd.shippingLocation!,
          weightG: parcel.weightG,
          volumeCm3: parcel.volumeCm3,
          merchandiseTotal: merchandise.totals.total,
          fulfillmentType: cmd.fulfillmentType as 'rider' | 'courier',
        });
    const shippingQuoted = delivery?.shippingTotal ?? '0.00';
    // Con el envío cotizado, las promociones de envío gratis calculan su descuento.
    const cart = toCents(shippingQuoted) > 0 ? await source.price(shippingQuoted) : merchandise;
    return this.placeOrderAndPayment(cmd, { cartId, cart, variants, parcel, delivery, shippingQuoted, pickup }, paymentKey);
  }

  private async placeOrderAndPayment(
    cmd: PlacementCommand,
    p: {
      cartId: string | null;
      cart: CartView;
      variants: Map<string, SellableVariant>;
      parcel: Parcel;
      delivery: ResolvedDelivery | null;
      shippingQuoted: string;
      pickup: boolean;
    },
    paymentKey: string,
  ): Promise<CheckoutResult> {
    const { cartId, cart, variants, parcel, delivery, shippingQuoted, pickup } = p;
    const shippingCents = toCents(shippingQuoted) - toCents(cart.shippingDiscount);
    const beforeGiftCard = toCents(cart.totals.total) + shippingCents;
    const giftCardCents = cmd.giftCardCode
      ? giftCardAmount(beforeGiftCard, (await this.promotions.getGiftCardBalance(cmd.tenantId, cmd.giftCardCode)).balance)
      : 0;
    const totalCents = beforeGiftCard - giftCardCents;
    if (cmd.expectedTotal && toCents(cmd.expectedTotal) !== totalCents) {
      throw new CheckoutTotalChangedError(fromCents(toCents(cmd.expectedTotal)), fromCents(totalCents));
    }
    // Facturación: identificación válida, o consumidor final dentro del máximo del SRI (sobre el
    // importe de la factura, que incluye lo pagado con gift card). Si no, 422 antes de reservar nada.
    const billingData = cmd.billing ?? { idType: cmd.customer.idType, idNumber: cmd.customer.idNumber };
    this.billing.assertBuyerCanBeInvoiced(
      { idType: billingData.idType as string | undefined, idNumber: billingData.idNumber as string | undefined },
      beforeGiftCard,
    );
    if (totalCents === 0 && giftCardCents === 0) {
      throw new InvalidCheckoutError('ZERO_TOTAL', 'Un pedido sin monto a pagar no se procesa por checkout');
    }
    const method: PaymentMethod = totalCents === 0 ? 'gift_card' : cmd.paymentMethod;
    const customTtl = method === cmd.paymentMethod ? (cmd.paymentTtlSeconds ?? null) : null;

    // 3. Reserva de stock (UPDATE condicional atómico en Inventario), un poco más larga que el pago.
    const orderId = randomUUID();
    const lines = cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
    const allocation = await this.inventory.planAllocation(cmd.tenantId, lines, pickup ? cmd.pickupWarehouseId : null);
    await this.inventory.reserveStock({
      tenantId: cmd.tenantId,
      orderId,
      lines: allocation,
      ttlSeconds: reservationTtlSeconds(customTtl ?? this.payments.paymentTtlSeconds(method)),
    });

    // 4. Cupos de promociones y saldo de la gift card.
    await this.promotions.redeem({
      tenantId: cmd.tenantId,
      orderId,
      userId: cmd.userId,
      email: cmd.customer.email,
      promotions: cart.promotions.map((p) => ({
        promotionId: p.promotionId,
        couponId: p.couponId,
        discount: fromCents(toCents(p.discount) + toCents(p.shippingDiscount)),
      })),
    });
    if (giftCardCents > 0) {
      await this.promotions.redeemGiftCard(cmd.tenantId, cmd.giftCardCode!, orderId, fromCents(giftCardCents));
    }

    // 5. Pedido con snapshots (Pedidos recalcula IVA y total por línea; deben coincidir).
    const order = await this.orders.placeOrder(
      {
        id: orderId,
        tenantId: cmd.tenantId,
        userId: cmd.userId,
        cartId,
        customer: cmd.customer,
        billing: cmd.billing ?? { name: cmd.customer.name, email: cmd.customer.email, idType: cmd.customer.idType, idNumber: cmd.customer.idNumber },
        paymentMethod: method,
        fulfillmentType: cmd.fulfillmentType,
        shippingAddress: pickup ? null : cmd.shippingAddress,
        shippingLocation: pickup ? null : (cmd.shippingLocation ?? null),
        shippingCity: pickup ? null : (cmd.shippingCity ?? null),
        shippingZoneId: delivery?.zoneId ?? null,
        deliverySlotId: delivery?.slotId ?? null,
        sourceWarehouseId: pickup ? cmd.pickupWarehouseId : sourceWarehouse(allocation),
        shippingTotal: fromCents(shippingCents),
        giftCardTotal: fromCents(giftCardCents),
        channel: cmd.channel,
        sellerId: cmd.sellerId,
        notes: cmd.notes,
        items: toOrderItems(cart.items, allocation, new Map([...variants.values()].map((v) => [v.variantId, v.unitCost]))),
      },
      cmd.actor,
    );
    if (toCents(order.total) !== totalCents) {
      throw new Error(`Total del pedido (${order.total}) distinto del calculado en checkout (${fromCents(totalCents)})`);
    }

    // 6. Cupo de la franja (UPDATE condicional: si otro cliente tomó el último, 409 y ROLLBACK de
    //    todo) y envío 'pending' para despacho.
    const booked = delivery
      ? await this.logistics.bookDelivery({
          tenantId: cmd.tenantId,
          orderId,
          resolved: delivery,
          originWarehouseId: sourceWarehouse(allocation),
          destination: {
            address: cmd.shippingAddress!,
            location: cmd.shippingLocation!,
            city: cmd.shippingCity ?? '',
            province: cmd.shippingProvince ?? null,
          },
          weightG: parcel.weightG,
          volumeCm3: parcel.volumeCm3,
          codAmount: method === 'cod' ? order.total : '0.00',
        })
      : null;

    // 7. Pago con clave de idempotencia. Con gift card total, se captura en el acto.
    const payment = await this.payments.createPayment({
      tenantId: cmd.tenantId,
      orderId,
      orderNumber: order.orderNumber!,
      method,
      amount: method === 'gift_card' ? fromCents(giftCardCents) : order.total,
      idempotencyKey: paymentKey,
      ttlSeconds: customTtl,
    });

    return {
      orderId,
      orderNumber: order.orderNumber!,
      status: order.status,
      paymentStatus: order.paymentStatus,
      totals: {
        subtotal: order.subtotal,
        discountTotal: order.discountTotal,
        taxTotal: order.taxTotal,
        shippingTotal: order.shippingTotal,
        giftCardTotal: order.giftCardTotal,
        total: order.total,
      },
      delivery: {
        fulfillmentType: cmd.fulfillmentType,
        shipmentId: booked?.shipmentId ?? null,
        trackingToken: booked?.trackingToken ?? null,
        zoneId: delivery?.zoneId ?? null,
        deliverySlotId: delivery?.slotId ?? null,
      },
      payment,
    };
  }


  /**
   * Mercadería con precios (sin envío), lista para comprar, con el paquete que se cotiza.
   * 409 CART_NOT_READY si alguna línea está agotada, sin stock suficiente o no disponible.
   */
  async pricedParcel(
    tenantId: string,
    source: PricingSource,
  ): Promise<{ cart: CartView; variants: Map<string, SellableVariant>; parcel: Parcel }> {
    const cart = await source.price();
    if (!cart.canCheckout) throw new CartNotReadyError({ lines: blockingIssues(cart.items) });
    const variants = await this.catalog.getSellableVariants(tenantId, cart.items.map((i) => i.variantId));
    return { cart, variants, parcel: parcelOf(cart.items, variants) };
  }
}

/** Validaciones de entrega previas a tocar nada (422). */
function assertFulfillment(cmd: Pick<PlacementCommand, 'fulfillmentType' | 'pickupWarehouseId' | 'shippingAddress' | 'shippingLocation' | 'deliveryQuoteId'>): void {
  const pickup = cmd.fulfillmentType === 'pickup';
  if (pickup && !cmd.pickupWarehouseId) {
    throw new InvalidCheckoutError('PICKUP_WAREHOUSE_REQUIRED', 'Indica la tienda de retiro');
  }
  if (!pickup && !cmd.shippingAddress) {
    throw new InvalidCheckoutError('SHIPPING_ADDRESS_REQUIRED', 'Indica la dirección de entrega');
  }
  if (!pickup && !cmd.shippingLocation) {
    throw new InvalidCheckoutError('SHIPPING_LOCATION_REQUIRED', 'Marca la dirección en el mapa (lat y lng) para cotizar el envío');
  }
  if (!pickup && !cmd.deliveryQuoteId) {
    throw new InvalidCheckoutError('DELIVERY_QUOTE_REQUIRED', 'Elige una opción de envío (POST /checkout/delivery-options)');
  }
}
