import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, IdempotencyStore, IdempotentResponse, NotFoundError } from '../../../shared-kernel';
import { CartApi, CartView, CouponRejectedError, CouponStatus } from '../../cart';
import { CrmApi, CustomerAddress } from '../../crm';
import { CustomerSummary, IamApi } from '../../iam';
import { DeliveryQuote } from '../../logistics';
import { CustomerSnapshot, FulfillmentType, OrderNotFoundError, OrdersApi, OrderSummary } from '../../orders';
import { PaymentsApi, PublicPaymentView, VoucherInput } from '../../payments';
import {
  AssistedPaymentMethod,
  AssistedPaymentView,
  AssistedOrderError,
  assistedPaymentTtlSeconds,
  assistedPaymentView,
  AssistedTotals,
  assistedTotals,
  customerSnapshot,
  gatewayMethod,
  GuestCustomer,
} from '../domain/assisted-order';
import { blockingIssues } from '../domain/checkout';
import { CheckoutResult, CheckoutService, PricingSource } from './checkout.service';

/** Cliente del pedido: uno registrado (búsqueda) o un invitado con sus datos. */
export type AssistedCustomerRef = { userId: string } | { guest: GuestCustomer };

/** Dirección de entrega tal como llega del backoffice (lat/lng pueden venir en `location`). */
export interface AssistedAddress {
  mainStreet: string;
  secondaryStreet?: string;
  number?: string;
  reference?: string;
  city: string;
  province?: string;
  neighborhood?: string;
  lat?: number;
  lng?: number;
}

export interface AssistedFulfillment {
  type: FulfillmentType;
  address?: AssistedAddress;
  location?: { lat: number; lng: number };
  /** Dirección guardada del cliente registrado (CRM), en lugar de `address`. */
  addressId?: string;
  pickupWarehouseId?: string;
  /** options[].quoteId de POST /assisted-orders/quote (motorizado o courier). */
  quoteToken?: string;
  /** options[].slots[].slotId (motorizado). */
  slotId?: string;
}

export interface AssistedQuoteCommand {
  tenantId: string;
  /** Opcional en la cotización: con él se aplican promociones y límites de cupón por cliente. */
  customer?: AssistedCustomerRef;
  items: { variantId: string; quantity: number }[];
  couponCode?: string;
  fulfillment: AssistedFulfillment;
}

export interface AssistedOrderCommand extends AssistedQuoteCommand {
  customer: AssistedCustomerRef;
  sellerId: string;
  idempotencyKey: string;
  paymentMethod: AssistedPaymentMethod;
  billing?: Record<string, unknown> | null;
  notes?: string | null;
  /** Total que vio el vendedor; si cambió, 409 CHECKOUT_TOTAL_CHANGED. */
  expectedTotal?: string | null;
}

export interface AssistedCustomerView {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  idType: string | null;
  idNumber: string | null;
  status: CustomerSummary['status'];
  addresses: CustomerAddress[];
}

/** Opción de envío de la cotización con el total del pedido si se elige (y por franja). */
export type AssistedDeliveryOption = DeliveryQuote['options'][number] & {
  shippingTotal: string;
  total: string;
  slots?: (NonNullable<DeliveryQuote['options'][number]['slots']>[number] & { shippingTotal: string; total: string })[];
};

export interface AssistedQuote {
  /** false: hay líneas agotadas, sin stock suficiente o no disponibles (ver `issues`). */
  canPlace: boolean;
  issues: ReturnType<typeof blockingIssues>;
  items: CartView['items'];
  coupons: CouponStatus[];
  promotions: CartView['promotions'];
  /** Con la primera opción de envío (y su primera franja); sin envío en retiro en tienda. */
  totals: AssistedTotals;
  delivery: (Omit<DeliveryQuote, 'options'> & { options: AssistedDeliveryOption[] }) | null;
}

export interface AssistedOrderResult {
  orderId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  channel: 'backoffice';
  sellerId: string;
  total: string;
  totals: CheckoutResult['totals'];
  delivery: CheckoutResult['delivery'];
  payment: AssistedPaymentView;
}

/**
 * Pedidos asistidos del backoffice. Reutiliza el checkout (CheckoutService.placePriced: envío
 * firmado, reserva de stock, promociones, pedido y pago en UNA transacción), cambiando solo la
 * fuente de precios: en lugar del carrito del cliente, un borrador en memoria con los ítems que
 * arma el vendedor (CartApi.priceDraft, mismas reglas que un carrito). El pedido queda con
 * channel 'backoffice' y seller_id del vendedor; el cliente recibe las notificaciones normales.
 */
@Injectable()
export class AssistedOrderService {
  constructor(
    private readonly idempotency: IdempotencyStore,
    private readonly carts: CartApi,
    private readonly checkout: CheckoutService,
    private readonly iam: IamApi,
    private readonly crm: CrmApi,
    private readonly orders: OrdersApi,
    private readonly payments: PaymentsApi,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Clientes del tenant por email, nombre, teléfono o identificación (máx. 20), con sus direcciones. */
  async searchCustomers(tenantId: string, term: string): Promise<AssistedCustomerView[]> {
    const found = await this.iam.searchCustomers(tenantId, term, 20);
    return Promise.all(found.map(async (c) => ({ ...c, addresses: await this.crm.listCustomerAddresses(tenantId, c.userId) })));
  }

  /** Totales y opciones de envío (con token firmado) sin reservar nada. */
  async quote(cmd: AssistedQuoteCommand): Promise<AssistedQuote> {
    const who = cmd.customer ? await this.resolveCustomer(cmd.tenantId, cmd.customer) : null;
    const source = this.draftSource(cmd, who, { strictCoupons: false });
    const cart = await source.price();
    const base = {
      canPlace: cart.canCheckout,
      issues: blockingIssues(cart.items),
      items: cart.items,
      coupons: cart.coupons,
      promotions: cart.promotions,
    };
    if (cmd.fulfillment.type === 'pickup' || !cart.canCheckout) {
      return { ...base, totals: assistedTotals(cart, '0.00'), delivery: null };
    }

    const destination = await this.destination(cmd.tenantId, cmd.fulfillment, who?.userId ?? null);
    const { parcel } = await this.checkout.pricedParcel(cmd.tenantId, { cartId: null, price: async () => cart });
    const quote = await this.checkout.quoteParcel(cmd.tenantId, cart, parcel, {
      lat: destination.location.lat,
      lng: destination.location.lng,
      city: destination.address.city,
      province: destination.address.province ?? null,
    });

    // Total del pedido por precio de envío distinto (las promociones de envío gratis dependen de él).
    const byShipping = new Map<string, Promise<AssistedTotals>>();
    const totalsFor = (shipping: string) => {
      if (!byShipping.has(shipping)) byShipping.set(shipping, source.price(shipping).then((c) => assistedTotals(c, shipping)));
      return byShipping.get(shipping)!;
    };
    const options: AssistedDeliveryOption[] = await Promise.all(
      quote.options.map(async ({ slots: rawSlots, ...o }) => {
        const own = await totalsFor(o.price);
        const option: AssistedDeliveryOption = { ...o, ...pick(own) };
        if (rawSlots) option.slots = await Promise.all(rawSlots.map(async (s) => ({ ...s, ...pick(await totalsFor(s.price)) })));
        return option;
      }),
    );
    const first = options[0];
    const defaultShipping = first ? (first.slots?.[0]?.price ?? first.price) : '0.00';
    return { ...base, totals: await totalsFor(defaultShipping), delivery: { ...quote, options } };
  }

  /** POST /assisted-orders: idempotente por (vendedor, Idempotency-Key). */
  async create(cmd: AssistedOrderCommand): Promise<IdempotentResponse<AssistedOrderResult>> {
    const userRef = `staff:${cmd.sellerId}`;
    const { tenantId: _t, sellerId: _s, idempotencyKey, ...request } = cmd;
    return this.idempotency.execute(
      { scope: 'assisted-order', userRef, key: idempotencyKey, request },
      async () => ({ status: 201, body: await this.place(cmd, `assisted:${cmd.sellerId}:${idempotencyKey}`) }),
    );
  }

  /** Pedidos del canal backoffice (mine: solo los que tomó este vendedor), el más reciente primero. */
  list(tenantId: string, sellerId: string | null, limit: number, offset: number): Promise<OrderSummary[]> {
    return this.orders.listOrders(tenantId, { channel: 'backoffice', sellerId: sellerId ?? undefined, limit, offset });
  }

  /**
   * POST /assisted-orders/:orderId/transfer-voucher: el vendedor sube el comprobante que el cliente
   * le mandó por WhatsApp (no tiene el client secret). Solo pedidos del canal backoffice del tenant:
   * un pedido web responde 404, igual que uno inexistente. El pago queda pending hasta que otra
   * persona con payments.transfer.verify lo apruebe o rechace.
   */
  async submitTransferVoucher(tenantId: string, orderId: string, staffId: string, input: VoucherInput): Promise<PublicPaymentView> {
    const order = await this.orders.getOrder(tenantId, orderId);
    if (order.channel !== 'backoffice') throw new OrderNotFoundError(orderId);
    return this.payments.submitTransferVoucherAsStaff(tenantId, orderId, staffId, input);
  }

  /** Corre dentro de la transacción de IdempotencyStore: todo o nada. */
  private async place(cmd: AssistedOrderCommand, paymentKey: string): Promise<AssistedOrderResult> {
    const who = await this.resolveCustomer(cmd.tenantId, cmd.customer);
    const f = cmd.fulfillment;
    const pickup = f.type === 'pickup';
    const destination = pickup ? null : await this.destination(cmd.tenantId, f, who.userId);
    const result = await this.checkout.placePriced(
      {
        tenantId: cmd.tenantId,
        userId: who.userId,
        customer: who.snapshot,
        billing: cmd.billing ?? null,
        fulfillmentType: f.type,
        shippingAddress: destination ? { ...destination.address, lat: destination.location.lat, lng: destination.location.lng } : null,
        shippingLocation: destination?.location ?? null,
        shippingCity: destination?.address.city ?? null,
        shippingProvince: destination?.address.province ?? null,
        deliveryQuoteId: f.quoteToken ?? null,
        deliverySlotId: f.slotId ?? null,
        pickupWarehouseId: f.pickupWarehouseId ?? null,
        paymentMethod: gatewayMethod(cmd.paymentMethod),
        giftCardCode: null,
        expectedTotal: cmd.expectedTotal ?? null,
        notes: cmd.notes ?? null,
        channel: 'backoffice',
        sellerId: cmd.sellerId,
        actor: { type: 'staff', id: cmd.sellerId },
        // Enlace o transferencia que el cliente paga más tarde por WhatsApp: plazo más largo que el web.
        paymentTtlSeconds: assistedPaymentTtlSeconds(cmd.paymentMethod, this.config.payments),
      },
      this.draftSource(cmd, who, { strictCoupons: true }),
      paymentKey,
    );
    return {
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      status: result.status,
      paymentStatus: result.paymentStatus,
      channel: 'backoffice',
      sellerId: cmd.sellerId,
      total: result.totals.total,
      totals: result.totals,
      delivery: result.delivery,
      payment: assistedPaymentView(cmd.paymentMethod, result.payment),
    };
  }

  /**
   * Borrador en memoria como fuente de precios. Con strictCoupons (al crear el pedido), un cupón
   * que no aplica es un error (422 con el motivo del motor de promociones), igual que en el carrito.
   */
  private draftSource(cmd: AssistedQuoteCommand, who: ResolvedCustomer | null, opts: { strictCoupons: boolean }): PricingSource {
    return {
      cartId: null,
      price: async (shippingTotal?: string) => {
        const cart = await this.carts.priceDraft(
          {
            tenantId: cmd.tenantId,
            userId: who?.userId ?? null,
            email: who?.snapshot.email ?? null,
            items: cmd.items,
            couponCodes: cmd.couponCode ? [cmd.couponCode] : [],
          },
          shippingTotal,
        );
        const rejected = cart.coupons.find((c) => !c.applied);
        if (opts.strictCoupons && rejected) {
          throw new CouponRejectedError(rejected.reason ?? 'COUPON_NOT_APPLICABLE', rejected.message ?? 'El cupón no aplica a este pedido', { code: rejected.code });
        }
        return cart;
      },
    };
  }

  private async resolveCustomer(tenantId: string, ref: AssistedCustomerRef): Promise<ResolvedCustomer> {
    if ('guest' in ref) return { userId: null, snapshot: customerSnapshot(ref.guest) };
    const found = await this.iam.findCustomer(tenantId, ref.userId);
    if (!found) throw new NotFoundError('CUSTOMER_NOT_FOUND', 'El cliente no existe', { userId: ref.userId });
    return { userId: found.userId, snapshot: customerSnapshot(found) };
  }

  /**
   * Dirección y punto de entrega: la guardada del cliente (addressId, debe tener ubicación) o la
   * que escribe el vendedor (lat/lng en `location` o en la misma dirección).
   */
  private async destination(
    tenantId: string,
    f: AssistedFulfillment,
    userId: string | null,
  ): Promise<{ address: AssistedAddress; location: { lat: number; lng: number } }> {
    if (f.addressId) {
      if (!userId) throw new NotFoundError('ADDRESS_NOT_FOUND', 'La dirección no existe', { id: f.addressId });
      const a = await this.crm.getCheckoutAddress(tenantId, userId, f.addressId);
      return {
        address: {
          mainStreet: a.mainStreet,
          secondaryStreet: a.secondaryStreet ?? undefined,
          number: a.number ?? undefined,
          reference: a.reference ?? undefined,
          city: a.city,
          province: a.province,
          neighborhood: a.neighborhood ?? undefined,
        },
        location: { lat: a.lat, lng: a.lng },
      };
    }
    const address = f.address;
    const lat = f.location?.lat ?? address?.lat;
    const lng = f.location?.lng ?? address?.lng;
    if (!address) throw new AssistedOrderError('SHIPPING_ADDRESS_REQUIRED', 'Indica la dirección de entrega');
    if (lat === undefined || lng === undefined) {
      throw new AssistedOrderError('SHIPPING_LOCATION_REQUIRED', 'Marca la dirección en el mapa (lat y lng) para cotizar el envío');
    }
    const { lat: _la, lng: _ln, ...rest } = address;
    return { address: rest, location: { lat, lng } };
  }
}

interface ResolvedCustomer {
  userId: string | null;
  snapshot: CustomerSnapshot;
}

/** Totales que se agregan a cada opción de envío. */
function pick(t: AssistedTotals): { shippingTotal: string; total: string } {
  return { shippingTotal: t.shippingTotal, total: t.total };
}

